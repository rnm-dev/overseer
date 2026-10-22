import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/diagnostics/app_diagnostics.dart';
import '../../../core/ids/request_id.dart';
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
  final SubmissionProgress? submissionProgress;
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
    SubmissionProgress? submissionProgress,
    bool clearSubmissionProgress = false,
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
  final _newSessionIdentity = _SubmissionIdentity<_NewSessionPayload>();
  final _followupIdentity = _SubmissionIdentity<_FollowupPayload>();
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
    _persistDraft(state.value!);
  }

  void selectModel(String? model) {
    final current = state.value;
    if (current == null) return;
    if (current.model != model) _selectionRevision++;
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
    if (current.reasoningEffort != reasoningEffort) _selectionRevision++;
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
        : ref.read(sessionDetailsSnapshotProvider(scope));
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
    final replyTo = state.value?.replyTo;
    final activeSessions = ref.read(activeSessionsProvider.notifier);
    final result = await _runSubmission<_FollowupPayload, FollowupDelivery>(
      identity: _followupIdentity,
      attachments: attachments,
      payloadFor: (selection, prompt) => _FollowupPayload(
        prompt: prompt,
        serverQueue: running,
        startNow: startNow,
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
        attachments: attachments,
        replyTo: replyTo,
      ),
      // A queued follow-up is Peon's to pop when it is ready, and the queue
      // widget already shows it. Only a turn that starts now gets a ghost.
      ghostFor: running && !startNow
          ? null
          : (prompt, commandId) => ComposerGhost(
              commandId: commandId,
              text: prompt.isEmpty ? '(see attachments)' : prompt,
              attachments: [
                for (final attachment in attachments)
                  ComposerGhostAttachment(
                    name: attachment.name,
                    type: attachment.type,
                    size: attachment.bytes.length,
                  ),
              ],
              replyTo: replyTo,
              createdAt: _clock.now().millisecondsSinceEpoch.toDouble(),
              baselineUserMessages: transcriptUserMessages,
            ),
      request: (submitted, prompt, commandId, onProgress) {
        activeSessions.markRunningLocally(
          workspaceId: scope.workspaceId,
          session: ActiveSession(
            peonId: scope.peonId,
            sessionId: scope.sessionId,
          ),
        );
        return ref
            .read(followupRepositoryProvider)
            .submit(
              scope: scope,
              prompt: prompt,
              serverQueue: running,
              startNow: startNow,
              model: submitted.model,
              reasoningEffort: submitted.reasoningEffort,
              commandId: commandId,
              attachments: attachments,
              replyTo: replyTo,
              onProgress: onProgress,
            );
      },
      onSuccess: (delivery) {
        if (delivery == FollowupDelivery.queued) {
          _clearRunningLocally(activeSessions);
          _scheduleRetry();
        }
        if (running) unawaited(refreshQueue());
      },
      errorMessage: (error) {
        _clearRunningLocally(activeSessions);
        if (error is FollowupException) {
          // Only an explicit HTTP 4xx refusal proves that this command
          // identity cannot have been accepted. Upload/protocol failures
          // without a status retain it so retrying the unchanged payload
          // remains idempotent.
          if (_isExplicitFollowupRefusal(error)) _followupIdentity.reset();
          return error.message;
        }
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
        return 'Message could not be sent.';
      },
    );
    return result != null;
  }

  void _clearRunningLocally(ActiveSessionsController activeSessions) {
    activeSessions.clearRunningLocally(
      workspaceId: scope.workspaceId,
      peonId: scope.peonId,
      sessionId: scope.sessionId,
    );
  }

  /// The submission skeleton shared by follow-ups and new sessions.
  ///
  /// The retry identity is purely payload-based: an unchanged payload reuses
  /// the command id of the last unfinished attempt (so a retry after an
  /// ambiguous failure stays idempotent), while any change — draft, selection,
  /// attachments, target — mints a new one. Returns null when nothing was sent
  /// or the request failed; [errorMessage] maps the failure for display and may
  /// reset [identity] when the failure proves the command was not accepted.
  Future<T?> _runSubmission<P extends Object, T extends Object>({
    required _SubmissionIdentity<P> identity,
    required List<NewSessionAttachment> attachments,
    required P Function(SessionComposerState selection, String prompt)
    payloadFor,
    required Future<T> Function(
      SessionComposerState submitted,
      String prompt,
      String commandId,
      SubmissionProgressCallback onProgress,
    )
    request,
    required String Function(Object error) errorMessage,
    ComposerGhost Function(String prompt, String commandId)? ghostFor,
    void Function(T result)? onSuccess,
  }) async {
    final current = state.value;
    if (current == null || current.sending) return null;
    final prompt = current.draft.trim();
    if (prompt.isEmpty && attachments.isEmpty) return null;
    var submitted = current;
    var payload = payloadFor(current, prompt);
    // A retry of the unchanged payload keeps its selection as sent; anything
    // new is normalized against the catalog first.
    if (!identity.matches(payload)) {
      submitted = _normalizedSelection(current);
      if (submitted != current) {
        _selectionRevision++;
        state = AsyncData(submitted);
        _persistDraft(submitted);
        payload = payloadFor(submitted, prompt);
      }
    }
    final commandId = identity.claim(payload);
    final ghost = ghostFor?.call(prompt, commandId);
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
        clearSubmissionProgress: true,
      ),
    );
    _persistDraft(submitted);
    if (ghost != null) _scheduleGhostExpiry();
    final submissionLifetime = ref.keepAlive();
    try {
      final T result;
      try {
        result = await request(submitted, prompt, commandId, (progress) {
          final latest = state.value;
          if (latest == null) return;
          state = AsyncData(latest.copyWith(submissionProgress: progress));
        });
      } catch (error) {
        final message = errorMessage(error);
        final latest = state.value ?? current;
        state = AsyncData(
          latest.copyWith(
            draft: _contentRevision == contentRevision ? prompt : latest.draft,
            sending: false,
            clearGhost: true,
            clearSubmissionProgress: true,
            replyTo: current.replyTo,
            error: message,
          ),
        );
        _persistDraft(state.value!);
        return null;
      }
      // Delivered: never restore the prompt after this point, or a resend
      // would post it twice under a fresh command id.
      final latest = state.value ?? current;
      final selectionUnchanged = _selectionRevision == selectionRevision;
      state = AsyncData(
        latest.copyWith(
          draft: _contentRevision == contentRevision ? '' : latest.draft,
          clearAgent: selectionUnchanged,
          clearModel: selectionUnchanged,
          clearReasoningEffort: selectionUnchanged,
          sending: false,
          clearSubmissionProgress: true,
        ),
      );
      _persistDraft(state.value!);
      identity.reset();
      onSuccess?.call(result);
      return result;
    } finally {
      await _draftWrite;
      submissionLifetime.close();
    }
  }

  void setReplyTo(SelectedTextReply? replyTo) {
    final current = state.value;
    if (current == null) return;
    state = AsyncData(
      current.copyWith(replyTo: replyTo, clearReplyTo: replyTo == null),
    );
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
  }) => _runSubmission<_NewSessionPayload, SessionSummary>(
    identity: _newSessionIdentity,
    attachments: attachments,
    payloadFor: (selection, prompt) => _NewSessionPayload(
      prompt: prompt,
      projectKey: projectKey,
      dir: dir?.trim(),
      agent: selection.agent,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
      attachments: attachments,
    ),
    request: (submitted, prompt, requestId, onProgress) => ref
        .read(newSessionRepositoryProvider)
        .createSession(
          NewSessionRequest(
            workspaceId: scope.workspaceId,
            peonId: scope.peonId,
            requestId: requestId,
            prompt: prompt,
            projectKey: projectKey,
            dir: dir,
            agent: submitted.agent,
            model: submitted.model,
            reasoningEffort: submitted.reasoningEffort,
            attachments: attachments,
            onProgress: onProgress,
          ),
        ),
    errorMessage: (error) {
      if (error is NewSessionException) return error.message;
      _diagnostics.record(
        AppDiagnosticEvent(
          name: 'session.create',
          level: AppDiagnosticLevel.error,
          workspaceId: scope.workspaceId,
          state: 'failed',
          errorType: error.runtimeType.toString(),
        ),
      );
      return 'Session could not be started. Press Send to retry.';
    },
  );

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
}

/// The command id of the last unfinished submission and the payload it was
/// minted for. [claim] reuses the id only for an equal payload.
class _SubmissionIdentity<P extends Object> {
  String? _id;
  P? _payload;

  bool matches(P payload) => _payload == payload;

  String claim(P payload) {
    if (_payload != payload) _id = null;
    _payload = payload;
    return _id ??= newRequestId();
  }

  void reset() {
    _id = null;
    _payload = null;
  }
}

class _NewSessionPayload {
  _NewSessionPayload({
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
  bool operator ==(Object other) =>
      other is _NewSessionPayload &&
      other.prompt == prompt &&
      other.projectKey == projectKey &&
      other.dir == dir &&
      other.agent == agent &&
      other.model == model &&
      other.reasoningEffort == reasoningEffort &&
      _sameAttachments(other.attachments, attachments);

  @override
  int get hashCode => Object.hash(
    prompt,
    projectKey,
    dir,
    agent,
    model,
    reasoningEffort,
    Object.hashAll(attachments),
  );
}

class _FollowupPayload {
  _FollowupPayload({
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
      other is _FollowupPayload &&
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
    SubmissionProgressCallback? onProgress,
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
