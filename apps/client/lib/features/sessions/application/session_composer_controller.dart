import 'dart:async';
import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/diagnostics/app_diagnostics.dart';
import '../../../core/live/active_sessions.dart';
import '../../../core/time/app_time.dart';
import '../../../shared/models/ai_capabilities.dart';
import '../domain/followup_repository.dart';
import '../domain/new_session_repository.dart';
import '../domain/session_models.dart';
import 'session_queue_change.dart';
import 'session_details_controller.dart';

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

enum QueuedFollowupAction { editing, removing, sending }

/// A committed turn that never reaches the transcript must not leave the ghost
/// hovering under it forever.
const _ghostMaxLifetime = Duration(seconds: 60);

bool _isExplicitFollowupRefusal(FollowupException error) {
  final status = error.statusCode;
  return status != null && status >= 400 && status < 500;
}

/// An attachment the operator sent, as far as the ghost needs to describe it.
/// The bytes are deliberately not retained.
class ComposerGhostAttachment {
  const ComposerGhostAttachment({
    required this.name,
    required this.type,
    this.size,
  });

  final String name;
  final String type;
  final int? size;
}

/// The message the operator has sent that Peon has not committed back yet.
///
/// It is deliberately not a transcript row: the transcript stays Peon's alone,
/// and this is a single placeholder rendered after it. It retires as soon as the
/// transcript shows more user messages than [baselineUserMessages] did when the
/// send started. Counting is deliberate — Overseer derives its own command id
/// for a follow-up, so a client cannot recognise its own message in the
/// transcript, and matching one by payload is a guess. A count cannot mistake
/// one message for another; at worst two operators send at once and this ghost
/// retires on the other's row, one beat before its own arrives.
class ComposerGhost {
  const ComposerGhost({
    required this.commandId,
    required this.text,
    required this.attachments,
    required this.createdAt,
    required this.baselineUserMessages,
    this.replyTo,
  });

  final String commandId;
  final String text;
  final List<ComposerGhostAttachment> attachments;
  final double createdAt;
  final int baselineUserMessages;
  final SelectedTextReply? replyTo;

  bool visibleAgainst(
    int userMessages, {
    Iterable<String?> queuedCommandIds = const [],
  }) =>
      userMessages <= baselineUserMessages &&
      !queuedCommandIds.contains(commandId);
}

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
    this.ghost,
    this.submissionProgress,
    this.followupProgress,
    this.error,
    this.queueError,
    this.replyTo,
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
  final ComposerGhost? ghost;
  final NewSessionSubmissionProgress? submissionProgress;
  final FollowupSubmissionProgress? followupProgress;
  final String? error;
  final String? queueError;
  final SelectedTextReply? replyTo;

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
    ComposerGhost? ghost,
    bool clearGhost = false,
    NewSessionSubmissionProgress? submissionProgress,
    bool clearSubmissionProgress = false,
    FollowupSubmissionProgress? followupProgress,
    bool clearFollowupProgress = false,
    String? error,
    bool clearError = false,
    String? queueError,
    bool clearQueueError = false,
    SelectedTextReply? replyTo,
    bool clearReplyTo = false,
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
      ghost: clearGhost ? null : ghost ?? this.ghost,
      submissionProgress: clearSubmissionProgress
          ? null
          : submissionProgress ?? this.submissionProgress,
      followupProgress: clearFollowupProgress
          ? null
          : followupProgress ?? this.followupProgress,
      error: clearError ? null : error ?? this.error,
      queueError: clearQueueError ? null : queueError ?? this.queueError,
      replyTo: clearReplyTo ? null : replyTo ?? this.replyTo,
    );
  }
}

class SessionComposerController extends AsyncNotifier<SessionComposerState> {
  SessionComposerController(this.scope);

  final FollowupScope scope;
  StreamSubscription<List<PendingFollowup>>? _pendingSubscription;
  StreamSubscription<List<QueuedFollowup>>? _queueSubscription;
  ScheduledTask? _retryTimer;
  ScheduledTask? _queuePollTimer;
  int _retryAttempt = 0;
  String? _newSessionRequestId;
  _NewSessionPayloadIdentity? _newSessionPayloadIdentity;
  String? _followupRequestId;
  _FollowupPayloadIdentity? _followupPayloadIdentity;
  bool _queueRefreshing = false;
  bool _queueRefreshAgain = false;
  bool _queueAvailable = true;
  late AppScheduler _scheduler;
  late AppClock _clock;
  late AppDiagnostics _diagnostics;
  ScheduledTask? _ghostTimer;
  ScheduledTask? _catalogRetryTimer;
  Future<void> _draftWrite = Future<void>.value();
  int _contentRevision = 0;
  int _selectionRevision = 0;
  int _catalogAttempts = 0;
  late FollowupRepository _repository;

  bool get _supportsQueue =>
      scope.sessionId != 'new-session' && _queueAvailable;

  @override
  Future<SessionComposerState> build() async {
    _scheduler = ref.read(appSchedulerProvider);
    _clock = ref.read(appClockProvider);
    _diagnostics = ref.read(appDiagnosticsProvider);
    final repository = _repository = ref.read(followupRepositoryProvider);
    final results = await Future.wait<Object?>([
      repository.loadDraft(scope),
      repository.watchPending(scope).first,
      if (_supportsQueue) repository.watchQueue(scope).first,
    ]);
    final draft = results[0]! as ComposerDraftState;
    final pending = results[1]! as List<PendingFollowup>;
    final queue = _supportsQueue
        ? results[2]! as List<QueuedFollowup>
        : const <QueuedFollowup>[];
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
    if (pending.isNotEmpty) {
      _scheduler.schedule(Duration.zero, _scheduleRetry);
    }
    ref.onDispose(() {
      _pendingSubscription?.cancel();
      _queueSubscription?.cancel();
      _retryTimer?.cancel();
      _queuePollTimer?.cancel();
      _ghostTimer?.cancel();
      _catalogRetryTimer?.cancel();
    });
    final initial = SessionComposerState(
      draft: draft.text,
      pending: pending,
      queue: queue,
      agent: draft.agent,
      model: draft.model,
      reasoningEffort: draft.reasoningEffort,
    );
    Future<void>.microtask(refreshCatalog);
    return initial;
  }

  void updateDraft(String draft) {
    final current = state.value;
    if (current == null || current.draft == draft) return;
    state = AsyncData(current.copyWith(draft: draft, clearError: true));
    _contentRevision++;
    _resetSubmissionIdentity();
    _persistDraft(state.value!);
  }

  void resetSubmissionIdentity() {
    if (state.value?.sending == true) return;
    _resetSubmissionIdentity();
  }

  void selectModel(String? model) {
    final current = state.value;
    if (current == null) return;
    if (current.model != model) {
      _selectionRevision++;
      _resetSubmissionIdentity();
    }
    state = AsyncData(
      current.copyWith(model: model, clearModel: model == null),
    );
    _persistDraft(state.value!);
  }

  void selectAgent(String? agent) {
    final current = state.value;
    if (current == null) return;
    if (current.agent != agent ||
        current.model != null ||
        current.reasoningEffort != null) {
      _selectionRevision++;
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
    _persistDraft(state.value!);
  }

  void selectReasoningEffort(String? reasoningEffort) {
    final current = state.value;
    if (current == null) return;
    if (current.reasoningEffort != reasoningEffort) {
      _selectionRevision++;
      _resetSubmissionIdentity();
    }
    state = AsyncData(
      current.copyWith(
        reasoningEffort: reasoningEffort,
        clearReasoningEffort: reasoningEffort == null,
      ),
    );
    _persistDraft(state.value!);
  }

  Future<void> _persistDraft(SessionComposerState current) {
    final draft = ComposerDraftState(
      text: current.draft,
      agent: current.agent,
      model: current.model,
      reasoningEffort: current.reasoningEffort,
    );
    _draftWrite = _draftWrite
        .catchError((_) {})
        .then((_) => _repository.saveDraft(scope, draft))
        .catchError((_) {});
    return _draftWrite;
  }

  SessionComposerState _normalizedSelection(SessionComposerState current) {
    final catalog = current.catalog;
    final details = scope.sessionId == 'new-session'
        ? null
        : ref.read(
            sessionDetailsSnapshotProvider(
              SessionDetailsScope(
                workspaceId: scope.workspaceId,
                peonId: scope.peonId,
                sessionId: scope.sessionId,
              ),
            ),
          );
    final provider = providerForAgent(
      catalog?.providers ?? const [],
      current.agent ??
          details?.agent ??
          (scope.sessionId == 'new-session' ? catalog?.defaultAgent : null),
    );
    if (provider == null) return current;
    final effectiveModel = effectiveCapability(
      provider.models,
      explicit: current.model,
      inherited: details?.model,
    );
    // An unknown/stale model remains an intentional explicit value. Normalize
    // only when this successful catalog knows the effective model.
    if (modelOptionFor(provider, effectiveModel) == null) return current;
    final efforts = reasoningEffortsForModel(provider, effectiveModel);
    final effort = current.reasoningEffort;
    if (effort == null ||
        efforts.any(
          (option) => option.id == effort || option.alias == effort,
        )) {
      return current;
    }
    return current.copyWith(clearReasoningEffort: true);
  }

  /// Catalog discovery is auxiliary paint data: never hold a cached draft
  /// hostage to a slow or temporarily unavailable Peon.
  Future<void> refreshCatalog() async {
    try {
      final catalog = await ref
          .read(followupRepositoryProvider)
          .fetchModelCatalog(scope);
      if (!ref.mounted || catalog == null) return;
      final current = state.value;
      if (current == null) return;
      _catalogAttempts = 0;
      state = AsyncData(current.copyWith(catalog: catalog));
    } catch (_) {
      _scheduleCatalogRetry();
    }
  }

  void _scheduleCatalogRetry() {
    if (!ref.mounted || _catalogRetryTimer != null) return;
    _catalogAttempts++;
    final delay = _catalogAttempts <= 3
        ? const Duration(seconds: 5)
        : const Duration(seconds: 30);
    _catalogRetryTimer = _scheduler.schedule(delay, () {
      _catalogRetryTimer = null;
      unawaited(refreshCatalog());
    });
  }

  void _scheduleGhostExpiry() {
    _ghostTimer?.cancel();
    _ghostTimer = _scheduler.schedule(_ghostMaxLifetime, () {
      final latest = state.value;
      if (latest?.ghost == null) return;
      state = AsyncData(latest!.copyWith(clearGhost: true));
    });
  }

  Future<bool> submit({
    required bool running,
    required int transcriptUserMessages,
    bool startNow = false,
    List<NewSessionAttachment> attachments = const [],
  }) async {
    final current = state.value;
    if (current == null || current.sending) return false;
    final prompt = current.draft.trim();
    if (prompt.isEmpty && attachments.isEmpty) return false;
    final submitted = _followupPayloadIdentity == null
        ? _normalizedSelection(current)
        : current;
    if (submitted != current) {
      _selectionRevision++;
      state = AsyncData(submitted);
      _persistDraft(submitted);
    }
    final payloadIdentity = _FollowupPayloadIdentity(
      prompt: prompt,
      serverQueue: running,
      startNow: startNow,
      model: submitted.model,
      reasoningEffort: submitted.reasoningEffort,
      attachments: attachments,
      replyTo: current.replyTo,
    );
    if (_followupPayloadIdentity != null &&
        _followupPayloadIdentity != payloadIdentity) {
      _followupRequestId = null;
    }
    _followupRequestId ??= _commandId();
    _followupPayloadIdentity = payloadIdentity;
    // A queued follow-up is Peon's to pop when it is ready, and the queue widget
    // already shows it. Only a turn that starts now gets a ghost.
    final ghost = running && !startNow
        ? null
        : ComposerGhost(
            commandId: _followupRequestId!,
            text: prompt.isEmpty ? '(see attachments)' : prompt,
            attachments: [
              for (final attachment in attachments)
                ComposerGhostAttachment(
                  name: attachment.name,
                  type: attachment.type,
                  size: attachment.bytes.length,
                ),
            ],
            replyTo: current.replyTo,
            createdAt: _clock.now().millisecondsSinceEpoch.toDouble(),
            baselineUserMessages: transcriptUserMessages,
          );
    final contentRevision = _contentRevision;
    final selectionRevision = _selectionRevision;
    state = AsyncData(
      submitted.copyWith(
        draft: '',
        sending: true,
        ghost: ghost,
        clearGhost: ghost == null,
        clearReplyTo: true,
        clearError: true,
        clearFollowupProgress: true,
      ),
    );
    _persistDraft(submitted);
    final activeSessions = ref.read(activeSessionsProvider.notifier);
    activeSessions.markRunningLocally(
      workspaceId: scope.workspaceId,
      session: ActiveSession(peonId: scope.peonId, sessionId: scope.sessionId),
    );
    if (ghost != null) _scheduleGhostExpiry();
    final submissionLifetime = ref.keepAlive();
    try {
      final result = await ref
          .read(followupRepositoryProvider)
          .submit(
            scope: scope,
            prompt: prompt,
            serverQueue: running,
            startNow: startNow,
            model: submitted.model,
            reasoningEffort: submitted.reasoningEffort,
            commandId: _followupRequestId,
            attachments: attachments,
            replyTo: current.replyTo,
            onProgress: (progress) {
              final latest = state.value;
              if (latest == null) return;
              state = AsyncData(latest.copyWith(followupProgress: progress));
            },
          );
      final latest = state.value ?? current;
      final completed = latest.copyWith(
        draft: _contentRevision == contentRevision ? '' : latest.draft,
        clearAgent: _selectionRevision == selectionRevision,
        clearModel: _selectionRevision == selectionRevision,
        clearReasoningEffort: _selectionRevision == selectionRevision,
      );
      state = AsyncData(
        completed.copyWith(sending: false, clearFollowupProgress: true),
      );
      _persistDraft(state.value!);
      _resetFollowupIdentity();
      if (result == FollowupDelivery.queued) {
        activeSessions.clearRunningLocally(
          workspaceId: scope.workspaceId,
          peonId: scope.peonId,
          sessionId: scope.sessionId,
        );
        _scheduleRetry();
      }
      if (running) unawaited(refreshQueue());
      return true;
    } on FollowupException catch (error) {
      activeSessions.clearRunningLocally(
        workspaceId: scope.workspaceId,
        peonId: scope.peonId,
        sessionId: scope.sessionId,
      );
      // Only an explicit HTTP 4xx refusal proves that this command
      // identity cannot have been accepted. Upload/protocol failures without a
      // status retain it so retrying the unchanged payload remains idempotent.
      if (_isExplicitFollowupRefusal(error)) _resetFollowupIdentity();
      final latest = state.value ?? current;
      state = AsyncData(
        latest.copyWith(
          draft: _contentRevision == contentRevision ? prompt : latest.draft,
          sending: false,
          clearGhost: true,
          clearFollowupProgress: true,
          replyTo: current.replyTo,
          error: error.message,
        ),
      );
      _persistDraft(state.value!);
      return false;
    } catch (error) {
      activeSessions.clearRunningLocally(
        workspaceId: scope.workspaceId,
        peonId: scope.peonId,
        sessionId: scope.sessionId,
      );
      _diagnostics.record(
        AppDiagnosticEvent(
          name: 'followup.submit',
          level: AppDiagnosticLevel.error,
          workspaceId: scope.workspaceId,
          sessionId: scope.sessionId,
          state: 'failed',
          errorType: error.runtimeType.toString(),
        ),
      );
      final latest = state.value ?? current;
      state = AsyncData(
        latest.copyWith(
          draft: _contentRevision == contentRevision ? prompt : latest.draft,
          sending: false,
          clearGhost: true,
          clearFollowupProgress: true,
          replyTo: current.replyTo,
          error: 'Message could not be sent.',
        ),
      );
      _persistDraft(state.value!);
      return false;
    } finally {
      await _draftWrite;
      submissionLifetime.close();
    }
  }

  void _resetFollowupIdentity() {
    _followupRequestId = null;
    _followupPayloadIdentity = null;
  }

  void setReplyTo(SelectedTextReply? replyTo) {
    final current = state.value;
    if (current == null) return;
    state = AsyncData(
      current.copyWith(replyTo: replyTo, clearReplyTo: replyTo == null),
    );
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
        } catch (error) {
          if (!ref.mounted) return;
          _diagnostics.record(
            AppDiagnosticEvent(
              name: 'queue.refresh',
              level: AppDiagnosticLevel.warning,
              workspaceId: scope.workspaceId,
              sessionId: scope.sessionId,
              state: 'failed',
              errorType: error.runtimeType.toString(),
            ),
          );
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

  Future<void> removeQueued(String itemId) => _runQueueAction(itemId);

  Future<void> steerQueued(String itemId) =>
      _runQueueAction(itemId, steer: true);

  Future<void> editQueued(String itemId, String prompt) =>
      _runQueueAction(itemId, editPrompt: prompt);

  Future<void> _runQueueAction(
    String itemId, {
    bool steer = false,
    String? editPrompt,
  }) async {
    final current = state.value;
    if (current == null || current.queueActions.containsKey(itemId)) return;
    state = AsyncData(
      current.copyWith(
        queueActions: {
          ...current.queueActions,
          itemId: editPrompt != null
              ? QueuedFollowupAction.editing
              : steer
              ? QueuedFollowupAction.sending
              : QueuedFollowupAction.removing,
        },
        clearQueueError: true,
      ),
    );
    try {
      final repository = ref.read(followupRepositoryProvider);
      if (editPrompt != null) {
        final queued = current.queue
            .where((item) => item.id == itemId)
            .firstOrNull;
        await repository.editQueued(
          scope,
          itemId,
          editPrompt,
          replyTo: queued?.replyTo,
        );
      } else if (steer) {
        await repository.steerQueued(scope, itemId);
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
    _queuePollTimer ??= _scheduler.periodic(
      const Duration(seconds: 2),
      () => unawaited(refreshQueue()),
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
    final submitted = _newSessionPayloadIdentity == null
        ? _normalizedSelection(current)
        : current;
    if (submitted != current) {
      _selectionRevision++;
      state = AsyncData(submitted);
      _persistDraft(submitted);
    }
    final payloadIdentity = _NewSessionPayloadIdentity(
      prompt: prompt,
      projectKey: projectKey,
      dir: dir?.trim(),
      agent: submitted.agent,
      model: submitted.model,
      reasoningEffort: submitted.reasoningEffort,
      attachments: attachments,
    );
    if (_newSessionPayloadIdentity != null &&
        _newSessionPayloadIdentity != payloadIdentity) {
      _newSessionRequestId = null;
    }
    _newSessionRequestId ??= _commandId();
    _newSessionPayloadIdentity = payloadIdentity;
    final contentRevision = _contentRevision;
    final selectionRevision = _selectionRevision;
    state = AsyncData(
      submitted.copyWith(draft: '', sending: true, clearError: true),
    );
    _persistDraft(submitted);
    final submissionLifetime = ref.keepAlive();
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
              agent: submitted.agent,
              model: submitted.model,
              reasoningEffort: submitted.reasoningEffort,
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
      final latest = state.value ?? current;
      final completed = latest.copyWith(
        draft: _contentRevision == contentRevision ? '' : latest.draft,
        clearAgent: _selectionRevision == selectionRevision,
        clearModel: _selectionRevision == selectionRevision,
        clearReasoningEffort: _selectionRevision == selectionRevision,
      );
      state = AsyncData(
        completed.copyWith(sending: false, clearSubmissionProgress: true),
      );
      _persistDraft(state.value!);
      _newSessionRequestId = null;
      _newSessionPayloadIdentity = null;
      return session;
    } on NewSessionException catch (error) {
      final latest = state.value ?? current;
      state = AsyncData(
        latest.copyWith(
          draft: _contentRevision == contentRevision ? prompt : latest.draft,
          sending: false,
          clearSubmissionProgress: true,
          error: error.message,
        ),
      );
      _persistDraft(state.value!);
      return null;
    } catch (error) {
      _diagnostics.record(
        AppDiagnosticEvent(
          name: 'session.create',
          level: AppDiagnosticLevel.error,
          workspaceId: scope.workspaceId,
          state: 'failed',
          errorType: error.runtimeType.toString(),
        ),
      );
      final latest = state.value ?? current;
      state = AsyncData(
        latest.copyWith(
          draft: _contentRevision == contentRevision ? prompt : latest.draft,
          sending: false,
          clearSubmissionProgress: true,
          error: 'Session could not be started. Press Send to retry.',
        ),
      );
      _persistDraft(state.value!);
      return null;
    } finally {
      await _draftWrite;
      submissionLifetime.close();
    }
  }

  void _scheduleRetry() {
    if (_retryTimer != null) return;
    final seconds = 1 << _retryAttempt.clamp(1, 5);
    _retryAttempt++;
    _diagnostics.record(
      AppDiagnosticEvent(
        name: 'queue.retry',
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        state: 'scheduled',
        attempt: _retryAttempt,
      ),
    );
    _retryTimer = _scheduler.schedule(Duration(seconds: seconds), () async {
      _retryTimer = null;
      try {
        final stillPending = await ref
            .read(followupRepositoryProvider)
            .retryPending(scope);
        if (stillPending) {
          _diagnostics.record(
            AppDiagnosticEvent(
              name: 'queue.retry',
              workspaceId: scope.workspaceId,
              sessionId: scope.sessionId,
              state: 'pending',
              attempt: _retryAttempt,
            ),
          );
          _scheduleRetry();
        } else {
          _retryAttempt = 0;
          _diagnostics.record(
            AppDiagnosticEvent(
              name: 'queue.retry',
              workspaceId: scope.workspaceId,
              sessionId: scope.sessionId,
              state: 'complete',
            ),
          );
        }
      } on FollowupException catch (error) {
        final current = state.value;
        if (current != null) {
          state = AsyncData(current.copyWith(error: error.message));
        }
      } catch (error) {
        _diagnostics.record(
          AppDiagnosticEvent(
            name: 'queue.retry',
            level: AppDiagnosticLevel.warning,
            workspaceId: scope.workspaceId,
            sessionId: scope.sessionId,
            state: 'failed',
            outcome: 'retrying',
            attempt: _retryAttempt,
            errorType: error.runtimeType.toString(),
          ),
        );
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
    this.replyTo,
  }) : attachments = List.unmodifiable(
         attachments.map(_SubmissionAttachmentIdentity.new),
       );

  final String prompt;
  final bool serverQueue;
  final bool startNow;
  final String? model;
  final String? reasoningEffort;
  final List<_SubmissionAttachmentIdentity> attachments;
  final SelectedTextReply? replyTo;

  @override
  bool operator ==(Object other) =>
      other is _FollowupPayloadIdentity &&
      other.prompt == prompt &&
      other.serverQueue == serverQueue &&
      other.startNow == startNow &&
      other.model == model &&
      other.reasoningEffort == reasoningEffort &&
      other.replyTo == replyTo &&
      _sameAttachments(other.attachments, attachments);

  @override
  int get hashCode => Object.hash(
    prompt,
    serverQueue,
    startNow,
    model,
    reasoningEffort,
    replyTo,
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
  Future<ComposerDraftState> loadDraft(FollowupScope scope) async =>
      const ComposerDraftState();

  @override
  Future<void> saveDraft(FollowupScope scope, ComposerDraftState draft) async {}

  @override
  Stream<List<PendingFollowup>> watchPending(FollowupScope scope) =>
      const Stream.empty();

  @override
  Stream<List<QueuedFollowup>> watchQueue(FollowupScope scope) =>
      Stream.value(const []);

  @override
  Future<void> refreshQueue(FollowupScope scope) async {}

  @override
  Future<void> editQueued(
    FollowupScope scope,
    String itemId,
    String prompt, {
    SelectedTextReply? replyTo,
  }) async {}

  @override
  Future<void> removeQueued(FollowupScope scope, String itemId) async {}

  @override
  Future<void> steerQueued(FollowupScope scope, String itemId) async {}

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
    SelectedTextReply? replyTo,
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
