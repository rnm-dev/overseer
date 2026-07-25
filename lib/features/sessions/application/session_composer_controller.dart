import 'dart:async';
import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/followup_repository.dart';
import '../domain/new_session_repository.dart';
import '../domain/session_models.dart';
import 'session_queue_change.dart';

final followupRepositoryProvider = Provider<FollowupRepository>(
  (ref) => const _UnavailableFollowupRepository(),
);

final newSessionRepositoryProvider = Provider<NewSessionRepository>(
  (ref) => const _UnavailableNewSessionRepository(),
);

final sessionComposerControllerProvider = AsyncNotifierProvider.autoDispose
    .family<SessionComposerController, SessionComposerState, FollowupScope>(
      SessionComposerController.new,
      retry: (_, _) => null,
    );

enum QueuedFollowupAction { removing, sending }

class SessionComposerState {
  const SessionComposerState({
    required this.draft,
    this.pending = const [],
    this.queue = const [],
    this.queueActions = const {},
    this.catalog,
    this.agent,
    this.model,
    this.reasoningEffort,
    this.sending = false,
    this.submissionProgress,
    this.followupProgress,
    this.error,
    this.queueError,
  });

  final String draft;
  final List<PendingFollowup> pending;
  final List<QueuedFollowup> queue;
  final Map<String, QueuedFollowupAction> queueActions;
  final ModelsCatalog? catalog;
  final String? agent;
  final String? model;
  final String? reasoningEffort;
  final bool sending;
  final NewSessionSubmissionProgress? submissionProgress;
  final FollowupSubmissionProgress? followupProgress;
  final String? error;
  final String? queueError;

  SessionComposerState copyWith({
    String? draft,
    List<PendingFollowup>? pending,
    List<QueuedFollowup>? queue,
    Map<String, QueuedFollowupAction>? queueActions,
    ModelsCatalog? catalog,
    String? agent,
    String? model,
    String? reasoningEffort,
    bool clearAgent = false,
    bool clearModel = false,
    bool clearReasoningEffort = false,
    bool? sending,
    NewSessionSubmissionProgress? submissionProgress,
    bool clearSubmissionProgress = false,
    FollowupSubmissionProgress? followupProgress,
    bool clearFollowupProgress = false,
    String? error,
    bool clearError = false,
    String? queueError,
    bool clearQueueError = false,
  }) {
    return SessionComposerState(
      draft: draft ?? this.draft,
      pending: pending ?? this.pending,
      queue: queue ?? this.queue,
      queueActions: queueActions ?? this.queueActions,
      catalog: catalog ?? this.catalog,
      agent: clearAgent ? null : agent ?? this.agent,
      model: clearModel ? null : model ?? this.model,
      reasoningEffort: clearReasoningEffort
          ? null
          : reasoningEffort ?? this.reasoningEffort,
      sending: sending ?? this.sending,
      submissionProgress: clearSubmissionProgress
          ? null
          : submissionProgress ?? this.submissionProgress,
      followupProgress: clearFollowupProgress
          ? null
          : followupProgress ?? this.followupProgress,
      error: clearError ? null : error ?? this.error,
      queueError: clearQueueError ? null : queueError ?? this.queueError,
    );
  }
}

class SessionComposerController extends AsyncNotifier<SessionComposerState> {
  SessionComposerController(this.scope);

  final FollowupScope scope;
  StreamSubscription<List<PendingFollowup>>? _pendingSubscription;
  StreamSubscription<List<QueuedFollowup>>? _queueSubscription;
  Timer? _retryTimer;
  Timer? _queuePollTimer;
  int _retryAttempt = 0;
  String? _newSessionRequestId;
  _NewSessionPayloadIdentity? _newSessionPayloadIdentity;
  String? _followupRequestId;
  _FollowupPayloadIdentity? _followupPayloadIdentity;
  bool _queueRefreshing = false;
  bool _queueRefreshAgain = false;
  bool _queueAvailable = true;

  bool get _supportsQueue =>
      scope.sessionId != 'new-session' && _queueAvailable;

  @override
  Future<SessionComposerState> build() async {
    final repository = ref.read(followupRepositoryProvider);
    final results = await Future.wait<Object?>([
      repository.loadDraft(scope),
      repository.watchPending(scope).first,
      if (_supportsQueue) repository.watchQueue(scope).first,
      repository.fetchModelCatalog(scope),
    ]);
    final draft = results[0]! as String;
    final pending = results[1]! as List<PendingFollowup>;
    final queue = _supportsQueue
        ? results[2]! as List<QueuedFollowup>
        : const <QueuedFollowup>[];
    final catalog = results[_supportsQueue ? 3 : 2] as ModelsCatalog?;
    _pendingSubscription = repository.watchPending(scope).listen((pending) {
      final current = state.value;
      if (current == null) return;
      state = AsyncData(current.copyWith(pending: pending));
      if (pending.isNotEmpty) _scheduleRetry();
    });
    if (_supportsQueue) {
      _queueSubscription = repository.watchQueue(scope).listen((queue) {
        final current = state.value;
        if (current == null) return;
        state = AsyncData(current.copyWith(queue: queue));
        ref
            .read(sessionQueueChangeProvider(scope).notifier)
            .replacePending(queue.isNotEmpty);
        _scheduleQueuePoll(queue.isNotEmpty);
      });
      ref.listen(
        sessionQueueChangeProvider(scope).select((signal) => signal.revision),
        (_, _) => unawaited(refreshQueue()),
      );
      Future<void>.microtask(refreshQueue);
    }
    if (pending.isNotEmpty) Timer.run(_scheduleRetry);
    ref.onDispose(() {
      _pendingSubscription?.cancel();
      _queueSubscription?.cancel();
      _retryTimer?.cancel();
      _queuePollTimer?.cancel();
    });
    return SessionComposerState(
      draft: draft,
      pending: pending,
      queue: queue,
      catalog: catalog,
    );
  }

  void updateDraft(String draft) {
    final current = state.value;
    if (current == null || current.draft == draft) return;
    state = AsyncData(current.copyWith(draft: draft, clearError: true));
    _resetSubmissionIdentity();
    unawaited(ref.read(followupRepositoryProvider).saveDraft(scope, draft));
  }

  void resetSubmissionIdentity() {
    if (state.value?.sending == true) return;
    _resetSubmissionIdentity();
  }

  void selectModel(String? model) {
    final current = state.value;
    if (current == null) return;
    if (current.model != model) _resetSubmissionIdentity();
    state = AsyncData(
      current.copyWith(model: model, clearModel: model == null),
    );
  }

  void selectAgent(String? agent) {
    final current = state.value;
    if (current == null) return;
    if (current.agent != agent ||
        current.model != null ||
        current.reasoningEffort != null) {
      _resetSubmissionIdentity();
    }
    state = AsyncData(
      current.copyWith(
        agent: agent,
        clearAgent: agent == null,
        clearModel: true,
        clearReasoningEffort: true,
      ),
    );
  }

  void selectReasoningEffort(String? reasoningEffort) {
    final current = state.value;
    if (current == null) return;
    if (current.reasoningEffort != reasoningEffort) {
      _resetSubmissionIdentity();
    }
    state = AsyncData(
      current.copyWith(
        reasoningEffort: reasoningEffort,
        clearReasoningEffort: reasoningEffort == null,
      ),
    );
  }

  Future<bool> submit({
    required bool running,
    bool startNow = false,
    List<NewSessionAttachment> attachments = const [],
  }) async {
    final current = state.value;
    if (current == null || current.sending) return false;
    final prompt = current.draft.trim();
    if (prompt.isEmpty && attachments.isEmpty) return false;
    final payloadIdentity = _FollowupPayloadIdentity(
      prompt: prompt,
      serverQueue: running,
      startNow: startNow,
      model: current.model,
      reasoningEffort: current.reasoningEffort,
      attachments: attachments,
    );
    if (_followupPayloadIdentity != null &&
        _followupPayloadIdentity != payloadIdentity) {
      _followupRequestId = null;
    }
    _followupRequestId ??= _commandId();
    _followupPayloadIdentity = payloadIdentity;
    state = AsyncData(
      current.copyWith(
        sending: true,
        clearError: true,
        clearFollowupProgress: true,
      ),
    );
    try {
      final result = await ref
          .read(followupRepositoryProvider)
          .submit(
            scope: scope,
            prompt: prompt,
            serverQueue: running,
            startNow: startNow,
            model: current.model,
            reasoningEffort: current.reasoningEffort,
            commandId: _followupRequestId,
            attachments: attachments,
            onProgress: (progress) {
              final latest = state.value;
              if (latest == null) return;
              state = AsyncData(latest.copyWith(followupProgress: progress));
            },
          );
      await ref.read(followupRepositoryProvider).saveDraft(scope, '');
      final latest = state.value ?? current;
      state = AsyncData(
        latest.copyWith(draft: '', sending: false, clearFollowupProgress: true),
      );
      _resetFollowupIdentity();
      if (result == FollowupDelivery.queued) _scheduleRetry();
      if (running) unawaited(refreshQueue());
      return true;
    } on FollowupException catch (error) {
      final latest = state.value ?? current;
      state = AsyncData(
        latest.copyWith(
          sending: false,
          clearFollowupProgress: true,
          error: error.message,
        ),
      );
      return false;
    } catch (_) {
      final latest = state.value ?? current;
      state = AsyncData(
        latest.copyWith(
          sending: false,
          clearFollowupProgress: true,
          error: 'Message could not be sent.',
        ),
      );
      return false;
    }
  }

  void _resetFollowupIdentity() {
    _followupRequestId = null;
    _followupPayloadIdentity = null;
  }

  void _resetSubmissionIdentity() {
    _newSessionRequestId = null;
    _newSessionPayloadIdentity = null;
    _resetFollowupIdentity();
  }

  Future<void> refreshQueue() async {
    if (!_supportsQueue) return;
    if (_queueRefreshing) {
      _queueRefreshAgain = true;
      return;
    }
    _queueRefreshing = true;
    try {
      do {
        _queueRefreshAgain = false;
        try {
          await ref.read(followupRepositoryProvider).refreshQueue(scope);
          if (!ref.mounted) return;
          final current = state.value;
          if (current != null) {
            state = AsyncData(current.copyWith(clearQueueError: true));
          }
        } on FollowupException catch (error) {
          if (!ref.mounted) return;
          if (error.statusCode == 404) {
            _queueAvailable = false;
            _queueRefreshAgain = false;
            _scheduleQueuePoll(false);
            final current = state.value;
            if (current != null) {
              state = AsyncData(current.copyWith(clearQueueError: true));
            }
            break;
          }
          final current = state.value;
          if (current != null) {
            state = AsyncData(current.copyWith(queueError: error.message));
          }
        } catch (_) {
          if (!ref.mounted) return;
          final current = state.value;
          if (current != null) {
            state = AsyncData(
              current.copyWith(
                queueError: 'Queued messages could not be loaded.',
              ),
            );
          }
        }
      } while (_queueRefreshAgain);
    } finally {
      _queueRefreshing = false;
    }
  }

  Future<void> removeQueued(String itemId) =>
      _runQueueAction(itemId, sendNow: false);

  Future<void> sendQueuedNow(String itemId) =>
      _runQueueAction(itemId, sendNow: true);

  Future<void> _runQueueAction(String itemId, {required bool sendNow}) async {
    final current = state.value;
    if (current == null || current.queueActions.containsKey(itemId)) return;
    state = AsyncData(
      current.copyWith(
        queueActions: {
          ...current.queueActions,
          itemId: sendNow
              ? QueuedFollowupAction.sending
              : QueuedFollowupAction.removing,
        },
        clearQueueError: true,
      ),
    );
    try {
      final repository = ref.read(followupRepositoryProvider);
      if (sendNow) {
        await repository.sendQueuedNow(scope, itemId);
      } else {
        await repository.removeQueued(scope, itemId);
      }
    } on FollowupException catch (error) {
      final latest = state.value ?? current;
      state = AsyncData(latest.copyWith(queueError: error.message));
    } finally {
      final latest = state.value ?? current;
      state = AsyncData(
        latest.copyWith(queueActions: {...latest.queueActions}..remove(itemId)),
      );
    }
  }

  void _scheduleQueuePoll(bool needed) {
    if (!needed) {
      _queuePollTimer?.cancel();
      _queuePollTimer = null;
      return;
    }
    _queuePollTimer ??= Timer.periodic(
      const Duration(seconds: 2),
      (_) => unawaited(refreshQueue()),
    );
  }

  Future<SessionSummary?> startSession({
    String? projectKey,
    String? dir,
    List<NewSessionAttachment> attachments = const [],
  }) async {
    final current = state.value;
    if (current == null || current.sending) return null;
    final prompt = current.draft.trim();
    if (prompt.isEmpty && attachments.isEmpty) return null;
    final payloadIdentity = _NewSessionPayloadIdentity(
      prompt: prompt,
      projectKey: projectKey,
      dir: dir?.trim(),
      agent: current.agent,
      model: current.model,
      reasoningEffort: current.reasoningEffort,
      attachments: attachments,
    );
    if (_newSessionPayloadIdentity != null &&
        _newSessionPayloadIdentity != payloadIdentity) {
      _newSessionRequestId = null;
    }
    _newSessionRequestId ??= _commandId();
    _newSessionPayloadIdentity = payloadIdentity;
    state = AsyncData(current.copyWith(sending: true, clearError: true));
    try {
      final session = await ref
          .read(newSessionRepositoryProvider)
          .createSession(
            NewSessionRequest(
              workspaceId: scope.workspaceId,
              peonId: scope.peonId,
              requestId: _newSessionRequestId!,
              prompt: prompt,
              projectKey: projectKey,
              dir: dir,
              agent: current.agent,
              model: current.model,
              reasoningEffort: current.reasoningEffort,
              attachments: attachments,
              onProgress: (progress) {
                final latest = state.value;
                if (latest == null) return;
                state = AsyncData(
                  latest.copyWith(submissionProgress: progress),
                );
              },
            ),
          );
      await ref.read(followupRepositoryProvider).saveDraft(scope, '');
      final latest = state.value ?? current;
      state = AsyncData(
        latest.copyWith(
          draft: '',
          sending: false,
          clearSubmissionProgress: true,
        ),
      );
      _newSessionRequestId = null;
      _newSessionPayloadIdentity = null;
      return session;
    } on NewSessionException catch (error) {
      final latest = state.value ?? current;
      state = AsyncData(
        latest.copyWith(
          sending: false,
          clearSubmissionProgress: true,
          error: error.message,
        ),
      );
      return null;
    } catch (_) {
      final latest = state.value ?? current;
      state = AsyncData(
        latest.copyWith(
          sending: false,
          clearSubmissionProgress: true,
          error: 'Session could not be started. Press Send to retry.',
        ),
      );
      return null;
    }
  }

  void _scheduleRetry() {
    if (_retryTimer != null) return;
    final seconds = 1 << _retryAttempt.clamp(1, 5);
    _retryAttempt++;
    _retryTimer = Timer(Duration(seconds: seconds), () async {
      _retryTimer = null;
      try {
        final stillPending = await ref
            .read(followupRepositoryProvider)
            .retryPending(scope);
        if (stillPending) {
          _scheduleRetry();
        } else {
          _retryAttempt = 0;
        }
      } on FollowupException catch (error) {
        final current = state.value;
        if (current != null) {
          state = AsyncData(current.copyWith(error: error.message));
        }
      } catch (_) {
        _scheduleRetry();
      }
    });
  }

  String _commandId() {
    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    String hex(int start, int end) => bytes
        .sublist(start, end)
        .map((value) => value.toRadixString(16).padLeft(2, '0'))
        .join();
    return '${hex(0, 4)}-${hex(4, 6)}-${hex(6, 8)}-'
        '${hex(8, 10)}-${hex(10, 16)}';
  }
}

class _NewSessionPayloadIdentity {
  _NewSessionPayloadIdentity({
    required this.prompt,
    required this.projectKey,
    required this.dir,
    required this.agent,
    required this.model,
    required this.reasoningEffort,
    required List<NewSessionAttachment> attachments,
  }) : attachments = List.unmodifiable(
         attachments.map(_SubmissionAttachmentIdentity.new),
       );

  final String prompt;
  final String? projectKey;
  final String? dir;
  final String? agent;
  final String? model;
  final String? reasoningEffort;
  final List<_SubmissionAttachmentIdentity> attachments;

  @override
  bool operator ==(Object other) {
    if (other is! _NewSessionPayloadIdentity ||
        other.prompt != prompt ||
        other.projectKey != projectKey ||
        other.dir != dir ||
        other.agent != agent ||
        other.model != model ||
        other.reasoningEffort != reasoningEffort ||
        other.attachments.length != attachments.length) {
      return false;
    }
    for (var index = 0; index < attachments.length; index++) {
      final attachment = attachments[index];
      final otherAttachment = other.attachments[index];
      if (otherAttachment.name != attachment.name ||
          otherAttachment.type != attachment.type ||
          !identical(otherAttachment.bytes, attachment.bytes)) {
        return false;
      }
    }
    return true;
  }

  @override
  int get hashCode => Object.hash(
    prompt,
    projectKey,
    dir,
    agent,
    model,
    reasoningEffort,
    Object.hashAll(
      attachments.map(
        (attachment) => Object.hash(
          attachment.name,
          attachment.type,
          identityHashCode(attachment.bytes),
        ),
      ),
    ),
  );
}

class _FollowupPayloadIdentity {
  _FollowupPayloadIdentity({
    required this.prompt,
    required this.serverQueue,
    required this.startNow,
    required this.model,
    required this.reasoningEffort,
    required List<NewSessionAttachment> attachments,
  }) : attachments = List.unmodifiable(
         attachments.map(_SubmissionAttachmentIdentity.new),
       );

  final String prompt;
  final bool serverQueue;
  final bool startNow;
  final String? model;
  final String? reasoningEffort;
  final List<_SubmissionAttachmentIdentity> attachments;

  @override
  bool operator ==(Object other) =>
      other is _FollowupPayloadIdentity &&
      other.prompt == prompt &&
      other.serverQueue == serverQueue &&
      other.startNow == startNow &&
      other.model == model &&
      other.reasoningEffort == reasoningEffort &&
      _sameAttachments(other.attachments, attachments);

  @override
  int get hashCode => Object.hash(
    prompt,
    serverQueue,
    startNow,
    model,
    reasoningEffort,
    Object.hashAll(attachments),
  );
}

class _SubmissionAttachmentIdentity {
  _SubmissionAttachmentIdentity(NewSessionAttachment attachment)
    : name = attachment.name,
      type = attachment.type,
      bytes = attachment.bytes;

  final String name;
  final String type;
  final Object bytes;

  @override
  bool operator ==(Object other) =>
      other is _SubmissionAttachmentIdentity &&
      other.name == name &&
      other.type == type &&
      identical(other.bytes, bytes);

  @override
  int get hashCode => Object.hash(name, type, identityHashCode(bytes));
}

bool _sameAttachments(
  List<_SubmissionAttachmentIdentity> first,
  List<_SubmissionAttachmentIdentity> second,
) {
  if (first.length != second.length) return false;
  for (var index = 0; index < first.length; index++) {
    if (first[index] != second[index]) return false;
  }
  return true;
}

class _UnavailableFollowupRepository implements FollowupRepository {
  const _UnavailableFollowupRepository();

  @override
  Future<String> loadDraft(FollowupScope scope) async => '';

  @override
  Future<void> saveDraft(FollowupScope scope, String text) async {}

  @override
  Stream<List<PendingFollowup>> watchPending(FollowupScope scope) =>
      const Stream.empty();

  @override
  Stream<List<QueuedFollowup>> watchQueue(FollowupScope scope) =>
      Stream.value(const []);

  @override
  Future<void> refreshQueue(FollowupScope scope) async {}

  @override
  Future<void> removeQueued(FollowupScope scope, String itemId) async {}

  @override
  Future<void> sendQueuedNow(FollowupScope scope, String itemId) async {}

  @override
  Future<ModelsCatalog?> fetchModelCatalog(FollowupScope scope) async => null;

  @override
  Future<FollowupDelivery> submit({
    required FollowupScope scope,
    required String prompt,
    required bool serverQueue,
    bool startNow = false,
    String? agent,
    String? model,
    String? reasoningEffort,
    String? commandId,
    List<NewSessionAttachment> attachments = const [],
    FollowupProgressCallback? onProgress,
  }) {
    throw const FollowupException('Message sending is unavailable.');
  }

  @override
  Future<bool> retryPending(FollowupScope scope) async => false;
}

class _UnavailableNewSessionRepository implements NewSessionRepository {
  const _UnavailableNewSessionRepository();

  @override
  Future<SessionSummary> createSession(NewSessionRequest request) {
    throw const NewSessionException('Session creation is unavailable.');
  }
}
