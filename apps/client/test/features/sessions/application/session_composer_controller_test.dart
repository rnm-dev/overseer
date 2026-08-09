import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/sessions/application/session_composer_controller.dart';
import 'package:overseer_mobile/features/sessions/domain/followup_repository.dart';
import 'package:overseer_mobile/features/sessions/domain/new_session_repository.dart';
import 'package:overseer_mobile/features/sessions/domain/session_models.dart';
import 'package:overseer_mobile/shared/models/ai_capabilities.dart';

import '../../../support/manual_app_time.dart';
import 'package:overseer_mobile/core/time/app_time.dart';

void main() {
  test('authoritative queue item suppresses the composer ghost', () {
    const ghost = ComposerGhost(
      commandId: 'command-1',
      text: 'Send now',
      attachments: [],
      createdAt: 1,
      baselineUserMessages: 2,
    );

    expect(ghost.visibleAgainst(2), isTrue);
    expect(
      ghost.visibleAgainst(
        2,
        queuedCommandIds: const ['another-command', 'command-1'],
      ),
      isFalse,
    );
  });

  test(
    'concurrent authoritative rows retire a ghost by count and never payload',
    () {
      const ghost = ComposerGhost(
        commandId: 'web-command',
        text: 'same text can be sent by anyone',
        attachments: [],
        createdAt: 1,
        baselineUserMessages: 8,
      );

      expect(ghost.visibleAgainst(8), isTrue);
      expect(
        ghost.visibleAgainst(9),
        isFalse,
        reason: 'another operator row may retire it one beat early',
      );
      expect(ghost.visibleAgainst(10), isFalse);
    },
  );

  const scope = FollowupScope(
    workspaceId: 'workspace',
    peonId: 'peon',
    sessionId: 'session',
  );

  test('hydrates an existing durable draft and queue on startup', () async {
    final repository = _FakeFollowupRepository(
      draft: 'restore me',
      pending: const [
        PendingFollowup(
          commandId: 'command',
          scope: scope,
          prompt: 'retry me',
          serverQueue: false,
          startNow: false,
          createdAt: 1,
        ),
      ],
      queue: const [
        QueuedFollowup(
          id: 'queued',
          sessionId: 'session',
          prompt: 'next turn',
          queuedAt: 2,
        ),
      ],
    );
    final container = ProviderContainer(
      overrides: [followupRepositoryProvider.overrideWithValue(repository)],
    );
    addTearDown(container.dispose);

    final state = await container.read(
      sessionComposerControllerProvider(scope).future,
    );

    expect(state.draft, 'restore me');
    expect(state.pending.map((item) => item.commandId), ['command']);
    expect(state.queue.map((item) => item.id), ['queued']);
  });

  test('retries pending follow-ups with deterministic backoff', () async {
    final scheduler = ManualAppScheduler();
    final repository = _FakeFollowupRepository(
      draft: '',
      pending: const [
        PendingFollowup(
          commandId: 'command',
          scope: scope,
          prompt: 'retry me',
          serverQueue: false,
          startNow: false,
          createdAt: 1,
        ),
      ],
      retryResults: const [true, false],
    );
    final container = ProviderContainer(
      overrides: [
        followupRepositoryProvider.overrideWithValue(repository),
        appSchedulerProvider.overrideWithValue(scheduler),
      ],
    );
    addTearDown(container.dispose);
    final subscription = container.listen(
      sessionComposerControllerProvider(scope),
      (_, _) {},
      fireImmediately: true,
    );
    addTearDown(subscription.close);

    await container.read(sessionComposerControllerProvider(scope).future);
    await scheduler.advance(Duration.zero);
    expect(repository.retryCalls, 0);
    expect(scheduler.pendingDelays, contains(const Duration(seconds: 2)));

    await scheduler.advance(const Duration(seconds: 2));
    expect(repository.retryCalls, 1);

    await scheduler.advance(const Duration(seconds: 4));
    expect(repository.retryCalls, 2);
    expect(scheduler.pendingTaskCount, 0);
  });

  test(
    'first submit creates a session from the durable new-session draft',
    () async {
      const newScope = FollowupScope(
        workspaceId: 'workspace',
        peonId: 'peon',
        sessionId: 'new-session',
      );
      final followups = _FakeFollowupRepository(
        draft: 'Build the new session screen',
        pending: const [],
      );
      final sessions = _FakeNewSessionRepository();
      final container = ProviderContainer(
        overrides: [
          followupRepositoryProvider.overrideWithValue(followups),
          newSessionRepositoryProvider.overrideWithValue(sessions),
        ],
      );
      addTearDown(container.dispose);

      await container.read(sessionComposerControllerProvider(newScope).future);
      final created = await container
          .read(sessionComposerControllerProvider(newScope).notifier)
          .startSession();

      expect(created?.sessionId, 'created-session');
      expect(sessions.request?.prompt, 'Build the new session screen');
      expect(sessions.request?.requestId, isNotEmpty);
      expect(followups.savedDraft, '');
    },
  );

  test(
    'new-session retries keep an unchanged id and replace it for changed payloads',
    () async {
      const newScope = FollowupScope(
        workspaceId: 'workspace',
        peonId: 'peon',
        sessionId: 'new-session',
      );
      final followups = _FakeFollowupRepository(
        draft: 'Build it',
        pending: const [],
      );
      final sessions = _FakeNewSessionRepository(failures: 5);
      final container = ProviderContainer(
        overrides: [
          followupRepositoryProvider.overrideWithValue(followups),
          newSessionRepositoryProvider.overrideWithValue(sessions),
        ],
      );
      addTearDown(container.dispose);
      final controller = container.read(
        sessionComposerControllerProvider(newScope).notifier,
      );
      await container.read(sessionComposerControllerProvider(newScope).future);
      final attachment = NewSessionAttachment(
        name: 'plan.md',
        type: 'file',
        bytes: Uint8List.fromList([1, 2, 3]),
      );

      expect(
        await controller.startSession(
          projectKey: 'alpha',
          attachments: [attachment],
        ),
        isNull,
      );
      expect(
        await controller.startSession(
          projectKey: 'alpha',
          attachments: [attachment],
        ),
        isNull,
      );
      expect(sessions.requests[1].requestId, sessions.requests[0].requestId);

      expect(
        await controller.startSession(
          projectKey: 'beta',
          attachments: [attachment],
        ),
        isNull,
      );
      expect(
        sessions.requests[2].requestId,
        isNot(sessions.requests[1].requestId),
      );

      controller.updateDraft('Build it differently');
      expect(
        await controller.startSession(
          projectKey: 'beta',
          attachments: [attachment],
        ),
        isNull,
      );
      expect(
        sessions.requests[3].requestId,
        isNot(sessions.requests[2].requestId),
      );

      controller.resetSubmissionIdentity();
      expect(
        await controller.startSession(
          projectKey: 'beta',
          attachments: [attachment],
        ),
        isNull,
      );
      expect(
        sessions.requests[4].requestId,
        isNot(sessions.requests[3].requestId),
      );
    },
  );

  test('silently disables an unsupported authoritative queue', () async {
    final repository = _FakeFollowupRepository(
      draft: '',
      pending: const [],
      refreshErrors: const [
        FollowupException('unknown session', statusCode: 404),
      ],
    );
    final container = ProviderContainer(
      overrides: [followupRepositoryProvider.overrideWithValue(repository)],
    );
    addTearDown(container.dispose);
    final subscription = container.listen(
      sessionComposerControllerProvider(scope),
      (_, _) {},
      fireImmediately: true,
    );
    addTearDown(subscription.close);

    await container.read(sessionComposerControllerProvider(scope).future);
    await Future<void>.delayed(Duration.zero);

    final state = container
        .read(sessionComposerControllerProvider(scope))
        .requireValue;
    expect(state.queueError, isNull);
    expect(repository.refreshCalls, 1);

    await container
        .read(sessionComposerControllerProvider(scope).notifier)
        .refreshQueue();
    expect(repository.refreshCalls, 1);
  });

  test('unlocks queue reconciliation after an unexpected failure', () async {
    final repository = _FakeFollowupRepository(
      draft: '',
      pending: const [],
      refreshErrors: [StateError('database unavailable'), null],
    );
    final container = ProviderContainer(
      overrides: [followupRepositoryProvider.overrideWithValue(repository)],
    );
    addTearDown(container.dispose);
    final subscription = container.listen(
      sessionComposerControllerProvider(scope),
      (_, _) {},
      fireImmediately: true,
    );
    addTearDown(subscription.close);

    await container.read(sessionComposerControllerProvider(scope).future);
    await Future<void>.delayed(Duration.zero);
    expect(repository.refreshCalls, 1);

    await container
        .read(sessionComposerControllerProvider(scope).notifier)
        .refreshQueue();

    expect(repository.refreshCalls, 2);
    expect(
      container
          .read(sessionComposerControllerProvider(scope))
          .requireValue
          .queueError,
      isNull,
    );
  });

  test(
    'permanent refusals restore the draft and mint a new retry id',
    () async {
      final repository = _FakeFollowupRepository(
        draft: 'retry me',
        pending: const [],
        submitErrors: const [
          FollowupException('not sent', statusCode: 400),
          FollowupException('not sent', statusCode: 400),
          FollowupException('not sent', statusCode: 400),
          FollowupException('not sent', statusCode: 400),
          FollowupException('not sent', statusCode: 400),
        ],
      );
      final container = ProviderContainer(
        overrides: [followupRepositoryProvider.overrideWithValue(repository)],
      );
      addTearDown(container.dispose);
      final controller = container.read(
        sessionComposerControllerProvider(scope).notifier,
      );
      await container.read(sessionComposerControllerProvider(scope).future);

      expect(
        await controller.submit(running: true, transcriptUserMessages: 0),
        isFalse,
      );
      expect(
        await controller.submit(running: true, transcriptUserMessages: 0),
        isFalse,
      );
      expect(
        repository.submissions[1].commandId,
        isNot(repository.submissions[0].commandId),
      );

      controller.selectModel('gpt-5');
      expect(
        await controller.submit(running: true, transcriptUserMessages: 0),
        isFalse,
      );
      expect(
        repository.submissions[2].commandId,
        isNot(repository.submissions[1].commandId),
      );

      expect(
        await controller.submit(
          running: true,
          startNow: true,
          transcriptUserMessages: 0,
        ),
        isFalse,
      );
      expect(
        repository.submissions[3].commandId,
        isNot(repository.submissions[2].commandId),
      );

      final attachment = NewSessionAttachment(
        name: 'plan.md',
        type: 'file',
        bytes: Uint8List.fromList([1, 2, 3]),
      );
      expect(
        await controller.submit(
          running: true,
          startNow: true,
          transcriptUserMessages: 0,
          attachments: [attachment],
        ),
        isFalse,
      );
      expect(
        repository.submissions[4].commandId,
        isNot(repository.submissions[3].commandId),
      );
    },
  );

  test('ambiguous follow-up failures retain the retry identity', () async {
    final repository = _FakeFollowupRepository(
      draft: 'retry me',
      pending: const [],
      submitErrors: const [
        FollowupException('upload response was lost'),
        FollowupException('upload response was lost'),
      ],
    );
    final container = ProviderContainer(
      overrides: [followupRepositoryProvider.overrideWithValue(repository)],
    );
    addTearDown(container.dispose);
    final controller = container.read(
      sessionComposerControllerProvider(scope).notifier,
    );
    await container.read(sessionComposerControllerProvider(scope).future);

    expect(
      await controller.submit(running: false, transcriptUserMessages: 0),
      isFalse,
    );
    expect(
      await controller.submit(running: false, transcriptUserMessages: 0),
      isFalse,
    );
    expect(
      repository.submissions[1].commandId,
      repository.submissions[0].commandId,
    );
  });

  test(
    'clears the visible draft while a follow-up is being submitted',
    () async {
      final submissionGate = Completer<void>();
      final repository = _FakeFollowupRepository(
        draft: 'send me',
        pending: const [],
        submissionGate: submissionGate,
      );
      final container = ProviderContainer(
        overrides: [followupRepositoryProvider.overrideWithValue(repository)],
      );
      addTearDown(container.dispose);
      final controller = container.read(
        sessionComposerControllerProvider(scope).notifier,
      );
      await container.read(sessionComposerControllerProvider(scope).future);

      final submission = controller.submit(
        running: false,
        transcriptUserMessages: 0,
      );
      final submitting = container
          .read(sessionComposerControllerProvider(scope))
          .requireValue;
      expect(submitting.draft, isEmpty);
      expect(submitting.sending, isTrue);
      expect(repository.savedDraft, isNull);

      submissionGate.complete();
      expect(await submission, isTrue);
      expect(repository.savedDraft, isEmpty);
    },
  );

  test('restores the visible draft when follow-up submission fails', () async {
    final repository = _FakeFollowupRepository(
      draft: 'do not lose me',
      pending: const [],
      submitErrors: const [FollowupException('not sent')],
    );
    final container = ProviderContainer(
      overrides: [followupRepositoryProvider.overrideWithValue(repository)],
    );
    addTearDown(container.dispose);
    final controller = container.read(
      sessionComposerControllerProvider(scope).notifier,
    );
    await container.read(sessionComposerControllerProvider(scope).future);

    expect(
      await controller.submit(running: false, transcriptUserMessages: 0),
      isFalse,
    );
    final failed = container
        .read(sessionComposerControllerProvider(scope))
        .requireValue;
    expect(failed.draft, 'do not lose me');
    expect(failed.error, 'not sent');
    expect(repository.savedDraft, isNull);
  });

  test('bounds a delayed authoritative-row ghost to sixty seconds', () async {
    final scheduler = ManualAppScheduler();
    final submissionGate = Completer<void>();
    final repository = _FakeFollowupRepository(
      draft: 'accepted but publication is delayed',
      pending: const [],
      submissionGate: submissionGate,
    );
    final container = ProviderContainer(
      overrides: [
        followupRepositoryProvider.overrideWithValue(repository),
        appSchedulerProvider.overrideWithValue(scheduler),
      ],
    );
    addTearDown(container.dispose);
    final subscription = container.listen(
      sessionComposerControllerProvider(scope),
      (_, _) {},
      fireImmediately: true,
    );
    addTearDown(subscription.close);
    final controller = container.read(
      sessionComposerControllerProvider(scope).notifier,
    );
    await container.read(sessionComposerControllerProvider(scope).future);

    final submission = controller.submit(
      running: false,
      transcriptUserMessages: 3,
    );
    expect(
      container
          .read(sessionComposerControllerProvider(scope))
          .requireValue
          .ghost,
      isNotNull,
    );

    await scheduler.advance(const Duration(seconds: 59));
    expect(
      container
          .read(sessionComposerControllerProvider(scope))
          .requireValue
          .ghost,
      isNotNull,
    );
    await scheduler.advance(const Duration(seconds: 1));
    expect(
      container
          .read(sessionComposerControllerProvider(scope))
          .requireValue
          .ghost,
      isNull,
    );

    submissionGate.complete();
    expect(await submission, isTrue);
  });

  test('edits an authoritative queued prompt in place', () async {
    final repository = _FakeFollowupRepository(
      draft: '',
      pending: const [],
      queue: const [
        QueuedFollowup(
          id: 'queued',
          sessionId: 'session',
          prompt: 'Before',
          queuedAt: 1,
        ),
      ],
    );
    final container = ProviderContainer(
      overrides: [followupRepositoryProvider.overrideWithValue(repository)],
    );
    addTearDown(container.dispose);

    await container.read(sessionComposerControllerProvider(scope).future);
    await container
        .read(sessionComposerControllerProvider(scope).notifier)
        .editQueued('queued', 'After');

    expect(repository.editedItemId, 'queued');
    expect(repository.editedPrompt, 'After');
  });
}

class _FakeFollowupRepository implements FollowupRepository {
  _FakeFollowupRepository({
    required this.draft,
    required this.pending,
    this.queue = const [],
    this.refreshErrors = const [],
    this.submitErrors = const [],
    this.retryResults = const [],
    this.submissionGate,
  });

  final String draft;
  final List<PendingFollowup> pending;
  final List<QueuedFollowup> queue;
  final List<Object?> refreshErrors;
  final List<FollowupException> submitErrors;
  final List<bool> retryResults;
  final Completer<void>? submissionGate;
  final List<_SubmissionRecord> submissions = [];
  String? savedDraft;
  String? editedItemId;
  String? editedPrompt;
  int refreshCalls = 0;
  int retryCalls = 0;

  @override
  Future<String> loadDraft(FollowupScope scope) async => draft;

  @override
  Future<void> saveDraft(FollowupScope scope, String text) async {
    savedDraft = text;
  }

  @override
  Stream<List<PendingFollowup>> watchPending(FollowupScope scope) =>
      Stream.value(pending);

  @override
  Stream<List<QueuedFollowup>> watchQueue(FollowupScope scope) =>
      Stream.value(queue);

  @override
  Future<void> refreshQueue(FollowupScope scope) async {
    final error = refreshCalls < refreshErrors.length
        ? refreshErrors[refreshCalls]
        : null;
    refreshCalls++;
    if (error != null) throw error;
  }

  @override
  Future<void> editQueued(
    FollowupScope scope,
    String itemId,
    String prompt,
  ) async {
    editedItemId = itemId;
    editedPrompt = prompt;
  }

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
    FollowupProgressCallback? onProgress,
  }) async {
    submissions.add(
      _SubmissionRecord(
        commandId: commandId,
        serverQueue: serverQueue,
        startNow: startNow,
        model: model,
      ),
    );
    if (submissions.length <= submitErrors.length) {
      throw submitErrors[submissions.length - 1];
    }
    await submissionGate?.future;
    return FollowupDelivery.delivered;
  }

  @override
  Future<bool> retryPending(FollowupScope scope) async {
    final result = retryCalls < retryResults.length
        ? retryResults[retryCalls]
        : pending.isNotEmpty;
    retryCalls++;
    return result;
  }
}

class _SubmissionRecord {
  const _SubmissionRecord({
    required this.commandId,
    required this.serverQueue,
    required this.startNow,
    required this.model,
  });

  final String? commandId;
  final bool serverQueue;
  final bool startNow;
  final String? model;
}

class _FakeNewSessionRepository implements NewSessionRepository {
  _FakeNewSessionRepository({this.failures = 0});

  final int failures;
  NewSessionRequest? request;
  final List<NewSessionRequest> requests = [];

  @override
  Future<SessionSummary> createSession(NewSessionRequest request) async {
    this.request = request;
    requests.add(request);
    if (requests.length <= failures) {
      throw const NewSessionException('not started');
    }
    return const SessionSummary(
      workspaceId: 'workspace',
      peonId: 'peon',
      sessionId: 'created-session',
      title: 'Build the new session screen',
      syncedAt: 1,
    );
  }
}
