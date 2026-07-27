import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/live/transcript_live_service.dart';
import '../../settings/application/sound_pack_controller.dart';
import '../../settings/domain/sound_pack.dart';
import '../../settings/domain/work_sound_player.dart';
import '../domain/session_models.dart';
import '../domain/followup_repository.dart';
import 'session_queue_change.dart';
import 'sessions_controller.dart';

final transcriptLiveServiceProvider = Provider<TranscriptLiveService?>(
  (ref) => null,
);

final transcriptControllerProvider = AsyncNotifierProvider.autoDispose
    .family<TranscriptController, TranscriptState, TranscriptScope>(
      TranscriptController.new,
      retry: (_, _) => null,
    );

class TranscriptScope {
  const TranscriptScope({
    required this.workspaceId,
    required this.peonId,
    required this.sessionId,
    this.isRunning = false,
  });

  final String workspaceId;
  final String peonId;
  final String sessionId;
  final bool isRunning;

  @override
  bool operator ==(Object other) =>
      other is TranscriptScope &&
      other.workspaceId == workspaceId &&
      other.peonId == peonId &&
      other.sessionId == sessionId &&
      other.isRunning == isRunning;

  @override
  int get hashCode => Object.hash(workspaceId, peonId, sessionId, isRunning);
}

class TranscriptState {
  const TranscriptState({
    required this.events,
    this.isRunning = false,
    this.isRefreshing = false,
    this.isLoadingOlder = false,
    this.hasOlder = false,
    this.message,
  });

  final List<TranscriptEvent> events;
  final bool isRunning;
  final bool isRefreshing;
  final bool isLoadingOlder;
  final bool hasOlder;
  final String? message;

  TranscriptState copyWith({
    List<TranscriptEvent>? events,
    bool? isRunning,
    bool? isRefreshing,
    bool? isLoadingOlder,
    bool? hasOlder,
    String? message,
    bool clearMessage = false,
  }) {
    return TranscriptState(
      events: events ?? this.events,
      isRunning: isRunning ?? this.isRunning,
      isRefreshing: isRefreshing ?? this.isRefreshing,
      isLoadingOlder: isLoadingOlder ?? this.isLoadingOlder,
      hasOlder: hasOlder ?? this.hasOlder,
      message: clearMessage ? null : message ?? this.message,
    );
  }
}

class TranscriptController extends AsyncNotifier<TranscriptState> {
  TranscriptController(this.scope) : _running = scope.isRunning;

  static const _pageSize = 50;
  static const _reconciliationCheck = Duration(seconds: 5);
  static const _reconciliationSilence = Duration(seconds: 15);

  final TranscriptScope scope;
  StreamSubscription<List<TranscriptEvent>>? _subscription;
  Timer? _reconciliationTimer;
  String? _nextCursor;
  DateTime _lastTailActivity = DateTime.now();
  DateTime? _lastReconcileAt;
  bool _tailUnhealthy = false;
  bool _tailSubscribed = false;
  bool _reconciling = false;
  bool _running;
  bool _suppressNextCompletionSound = false;
  bool _initialSoundSnapshotReceived = false;
  bool _initialSoundCatchUpComplete = false;
  String? _initialTailBoundary;
  String? _initialSoundBoundary;
  final List<(String, Map<String, dynamic>)> _pendingInitialSounds = [];
  final Set<String> _soundedEventIds = {};
  late final FollowupScope _followupScope = FollowupScope(
    workspaceId: scope.workspaceId,
    peonId: scope.peonId,
    sessionId: scope.sessionId,
  );

  @override
  Future<TranscriptState> build() async {
    final repository = ref.read(sessionRepositoryProvider);
    final liveService = ref.read(transcriptLiveServiceProvider);
    final workSoundPlayer = ref.read(workSoundPlayerProvider);
    final cached = await repository.loadCachedTranscript(
      workspaceId: scope.workspaceId,
      peonId: scope.peonId,
      sessionId: scope.sessionId,
    );
    _subscription = repository
        .watchTranscript(
          workspaceId: scope.workspaceId,
          peonId: scope.peonId,
          sessionId: scope.sessionId,
        )
        .listen(_applyCachedEvents);
    _reconciliationTimer = Timer.periodic(
      _reconciliationCheck,
      (_) => unawaited(_reconcile()),
    );
    ref.onDispose(() {
      _reconciliationTimer?.cancel();
      unawaited(_subscription?.cancel());
      unawaited(workSoundPlayer.stop());
      liveService?.unsubscribeTranscript(
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
      );
    });
    ref.listen(soundPackControllerProvider, (_, _) {
      unawaited(workSoundPlayer.stop());
    });
    ref.listen(sessionQueueChangeProvider(_followupScope), (_, _) {});
    Future<void>.microtask(() async {
      final cachedBoundary = cached.events.lastOrNull?.eventId;
      _initialTailBoundary = cachedBoundary;
      if (cachedBoundary?.isNotEmpty == true) {
        _ensureTailSubscribed(cachedBoundary);
      }
      await refresh();
    });
    return TranscriptState(
      events: cached.events,
      isRunning: _running,
      hasOlder: cached.hasOlder,
    );
  }

  Future<void> refresh() => _refresh(reportFailure: true);

  Future<void> resumeFromBackground() => _refresh(reportFailure: false);

  Future<void> _refresh({required bool reportFailure}) async {
    if (!ref.mounted) return;
    final current = state.value;
    if (current == null || current.isRefreshing) return;
    if (reportFailure) {
      state = AsyncData(
        current.copyWith(isRefreshing: true, clearMessage: true),
      );
    }
    try {
      final page = await ref
          .read(sessionRepositoryProvider)
          .fetchLatestTranscript(
            workspaceId: scope.workspaceId,
            peonId: scope.peonId,
            sessionId: scope.sessionId,
            limit: _pageSize,
          );
      if (!ref.mounted) return;
      final runningSignal = _runningSignal(page.events);
      if (runningSignal != false || !_queueHasPending) {
        _running = runningSignal ?? _running;
      }
      _nextCursor = page.nextCursor;
      _establishInitialSoundBoundary(page.events.lastOrNull?.eventId);
      _ensureTailSubscribed(page.events.lastOrNull?.eventId);
      _tailUnhealthy = false;
      _lastTailActivity = DateTime.now();
      final latest = state.value ?? current;
      state = AsyncData(
        latest.copyWith(
          isRefreshing: false,
          isRunning: _running,
          hasOlder: page.hasMore,
          clearMessage: true,
        ),
      );
    } on SessionsException catch (error) {
      if (!ref.mounted) return;
      final latest = state.value ?? current;
      state = AsyncData(
        latest.copyWith(
          isRefreshing: false,
          message: reportFailure ? error.message : null,
          clearMessage: !reportFailure,
        ),
      );
    }
  }

  void _ensureTailSubscribed(String? lastEventId) {
    if (_tailSubscribed) return;
    final liveService = ref.read(transcriptLiveServiceProvider);
    if (liveService == null) return;
    liveService.subscribeTranscript(
      workspaceId: scope.workspaceId,
      peonId: scope.peonId,
      sessionId: scope.sessionId,
      lastEventId: lastEventId,
      onFrame: _handleTailFrame,
    );
    _tailSubscribed = true;
  }

  Future<void> _handleTailFrame(TranscriptTailFrame frame) async {
    if (!ref.mounted) return;
    if (frame.terminal) {
      _tailUnhealthy = true;
      _notifyQueueChanged();
      if (!frame.retryable) {
        final current = state.value;
        if (current != null) {
          state = AsyncData(
            current.copyWith(
              message:
                  frame.error ?? 'Live transcript updates are unavailable.',
            ),
          );
        }
      }
      await _reconcile(forceTranscript: true);
      return;
    }
    _lastTailActivity = DateTime.now();
    _tailUnhealthy = false;
    if (frame.event == 'change') {
      _notifyQueueChanged();
      return;
    }
    final eventId = frame.eventId;
    if (eventId == null || eventId.isEmpty) {
      await _reconcile(forceTranscript: true);
      return;
    }
    final Object? decoded;
    try {
      decoded = jsonDecode(frame.data);
    } on FormatException {
      await _reconcile(forceTranscript: true);
      return;
    }
    if (decoded is! Map) {
      await _reconcile(forceTranscript: true);
      return;
    }
    final payload = Map<String, dynamic>.from(decoded);
    if (payload['type'] == 'user_message') {
      _suppressNextCompletionSound = false;
    }
    await ref
        .read(sessionRepositoryProvider)
        .cacheTailEvent(
          workspaceId: scope.workspaceId,
          peonId: scope.peonId,
          sessionId: scope.sessionId,
          eventId: eventId,
          payload: payload,
        );
    if (!ref.mounted) return;
    _handleTailSound(eventId, payload);
    if (payload['type'] == 'result') {
      if (!_queueHasPending) {
        _setRunning(false);
      }
      await _reconcile(forceTranscript: true);
    } else if (_runStarted(payload)) {
      _setRunning(true);
    }
  }

  void _notifyQueueChanged() {
    ref
        .read(sessionQueueChangeProvider(_followupScope).notifier)
        .notifyChanged();
  }

  void _establishInitialSoundBoundary(String? eventId) {
    if (_initialSoundSnapshotReceived) return;
    _initialSoundSnapshotReceived = true;
    _initialSoundBoundary = eventId;

    if (!_tailSubscribed || eventId == _initialTailBoundary) {
      _initialSoundCatchUpComplete = true;
      final pending = List.of(_pendingInitialSounds);
      _pendingInitialSounds.clear();
      for (final (pendingId, pendingPayload) in pending) {
        _handleSound(pendingId, pendingPayload);
      }
      return;
    }
    if (eventId == null) {
      _initialSoundCatchUpComplete = true;
      _soundedEventIds.addAll(
        _pendingInitialSounds.map((pending) => pending.$1),
      );
      _pendingInitialSounds.clear();
      return;
    }

    final boundaryIndex = _pendingInitialSounds.lastIndexWhere(
      (pending) => pending.$1 == eventId,
    );
    if (boundaryIndex < 0) {
      _soundedEventIds.addAll(
        _pendingInitialSounds.map((pending) => pending.$1),
      );
      _pendingInitialSounds.clear();
      return;
    }

    _initialSoundCatchUpComplete = true;
    _soundedEventIds.addAll(
      _pendingInitialSounds
          .take(boundaryIndex + 1)
          .map((pending) => pending.$1),
    );
    final fresh = _pendingInitialSounds.skip(boundaryIndex + 1).toList();
    _pendingInitialSounds.clear();
    for (final (pendingId, pendingPayload) in fresh) {
      _handleSound(pendingId, pendingPayload);
    }
  }

  void _handleTailSound(String eventId, Map<String, dynamic> payload) {
    if (!_initialSoundSnapshotReceived) {
      _pendingInitialSounds.add((eventId, payload));
      return;
    }
    if (!_initialSoundCatchUpComplete) {
      _soundedEventIds.add(eventId);
      if (eventId == _initialSoundBoundary) {
        _initialSoundCatchUpComplete = true;
      }
      return;
    }
    _handleSound(eventId, payload);
  }

  void _handleSound(String eventId, Map<String, dynamic> payload) {
    if (!_soundedEventIds.add(eventId)) return;
    final player = ref.read(workSoundPlayerProvider);
    final type = payload['type'];
    if (type == 'result') {
      unawaited(player.stop());
      final completionSuppressed = _suppressNextCompletionSound;
      _suppressNextCompletionSound = false;
      if (!completionSuppressed &&
          payload['is_error'] != true &&
          !_queueHasPending) {
        final pack =
            ref.read(soundPackControllerProvider).asData?.value ??
            SoundPack.peon;
        unawaited(player.playCue(pack, WorkSoundCue.complete));
      }
      return;
    }
    if (!isAgentWorkSoundEvent(payload)) return;
    final pack =
        ref.read(soundPackControllerProvider).asData?.value ?? SoundPack.peon;
    unawaited(player.play(pack));
  }

  void suppressNextCompletionSound() {
    _suppressNextCompletionSound = true;
  }

  void restoreCompletionSound() {
    _suppressNextCompletionSound = false;
  }

  bool _runStarted(Map<String, dynamic> payload) {
    return const {
      'user_message',
      'system',
      'assistant',
      'user',
      'rate_limit_event',
    }.contains(payload['type']);
  }

  Future<void> _reconcile({bool forceTranscript = false}) async {
    if (_reconciling || state.value == null) return;
    final now = DateTime.now();
    if (_lastReconcileAt != null &&
        now.difference(_lastReconcileAt!) < _reconciliationSilence) {
      return;
    }
    if (!forceTranscript &&
        (!_running ||
            now.difference(_lastTailActivity) < _reconciliationSilence)) {
      return;
    }
    _reconciling = true;
    _lastReconcileAt = now;
    try {
      final details = await ref
          .read(sessionRepositoryProvider)
          .fetchDetails(
            workspaceId: scope.workspaceId,
            peonId: scope.peonId,
            sessionId: scope.sessionId,
          );
      if (!ref.mounted) return;
      final detailsRunning = details.status == 'running';
      if (detailsRunning || !_queueHasPending) {
        _setRunning(detailsRunning);
      }
      if (forceTranscript || _tailUnhealthy || !_running) {
        await _refresh(reportFailure: false);
      }
    } on SessionsException {
      // A transient fallback failure must not disturb cached transcript rows.
    } finally {
      _reconciling = false;
    }
  }

  Future<void> loadOlder() async {
    var current = state.value;
    if (current == null ||
        current.isLoadingOlder ||
        current.isRefreshing ||
        !current.hasOlder) {
      return;
    }
    if (_nextCursor == null) {
      await refresh();
      current = state.value;
      if (current == null || !current.hasOlder || _nextCursor == null) return;
    }

    state = AsyncData(
      current.copyWith(isLoadingOlder: true, clearMessage: true),
    );
    final usedCursors = <String>{};
    try {
      while (_nextCursor != null) {
        final cursor = _nextCursor!;
        if (!usedCursors.add(cursor)) {
          throw const SessionsException(
            'The transcript returned a repeated history cursor.',
          );
        }
        final page = await ref
            .read(sessionRepositoryProvider)
            .fetchOlderTranscript(
              workspaceId: scope.workspaceId,
              peonId: scope.peonId,
              sessionId: scope.sessionId,
              cursor: cursor,
              limit: _pageSize,
            );
        _nextCursor = page.nextCursor;
        if (page.insertedCount > 0 || !page.hasMore) {
          final latest = state.value ?? current;
          state = AsyncData(
            latest.copyWith(
              isLoadingOlder: false,
              hasOlder: page.hasMore,
              clearMessage: true,
            ),
          );
          return;
        }
      }
      final latest = state.value ?? current;
      state = AsyncData(
        latest.copyWith(
          isLoadingOlder: false,
          hasOlder: false,
          clearMessage: true,
        ),
      );
    } on SessionsException catch (error) {
      final latest = state.value ?? current;
      state = AsyncData(
        latest.copyWith(isLoadingOlder: false, message: error.message),
      );
    }
  }

  void _applyCachedEvents(List<TranscriptEvent> events) {
    final current = state.value;
    if (current == null) return;
    state = AsyncData(current.copyWith(events: events));
  }

  bool? _runningSignal(List<TranscriptEvent> events) {
    for (final event in events.reversed) {
      if (event.type == 'result') return false;
      if (_runStarted(event.payload)) return true;
    }
    return null;
  }

  void _setRunning(bool value) {
    _running = value;
    if (!value) unawaited(ref.read(workSoundPlayerProvider).stop());
    final current = state.value;
    if (current == null || current.isRunning == value) return;
    state = AsyncData(current.copyWith(isRunning: value));
  }

  bool get _queueHasPending =>
      ref.read(sessionQueueChangeProvider(_followupScope)).hasPending;
}
