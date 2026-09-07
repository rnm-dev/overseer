import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/live/active_sessions.dart';
import 'package:overseer_mobile/features/sessions/application/session_composer_controller.dart';
import 'package:overseer_mobile/features/sessions/application/session_details_controller.dart';
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

  test(
    'persists selection-only drafts and restores them on recreation',
    () async {
      final repository = _FakeFollowupRepository(draft: '', pending: const []);
      final first = ProviderContainer(
        overrides: [followupRepositoryProvider.overrideWithValue(repository)],
      );
      await first.read(sessionComposerControllerProvider(scope).future);
      first.read(sessionComposerControllerProvider(scope).notifier)
        ..selectModel('model-a')
        ..selectReasoningEffort('high');
      await Future<void>.delayed(Duration.zero);
      final saved = repository.savedDraftState!;
      first.dispose();

      final restored = _FakeFollowupRepository(
        draft: '',
        draftState: saved,
        pending: const [],
      );
      final second = ProviderContainer(
        overrides: [followupRepositoryProvider.overrideWithValue(restored)],
      );
      addTearDown(second.dispose);
      final state = await second.read(
        sessionComposerControllerProvider(scope).future,
      );
      expect(state.draft, isEmpty);
      expect(state.model, 'model-a');
      expect(state.reasoningEffort, 'high');
    },
  );

  test('A B A sends A as the explicit model ID', () async {
    final repository = _FakeFollowupRepository(
      draft: 'send',
      pending: const [],
    );
    final container = ProviderContainer(
      overrides: [followupRepositoryProvider.overrideWithValue(repository)],
    );
    addTearDown(container.dispose);
    await container.read(sessionComposerControllerProvider(scope).future);
    final controller = container.read(
      sessionComposerControllerProvider(scope).notifier,
    );
    controller
      ..selectModel('model-a')
      ..selectModel('model-b')
      ..selectModel('model-a');
    await controller.submit(running: false, transcriptUserMessages: 0);
    expect(repository.submissions.single.model, 'model-a');
  });

  test('a refused submission retains the selected model and effort', () async {
    final repository = _FakeFollowupRepository(
      draft: 'send',
      pending: const [],
      submitErrors: const [FollowupException('refused', statusCode: 400)],
    );
    final container = ProviderContainer(
      overrides: [followupRepositoryProvider.overrideWithValue(repository)],
    );
    addTearDown(container.dispose);
    await container.read(sessionComposerControllerProvider(scope).future);
    final controller =
        container.read(sessionComposerControllerProvider(scope).notifier)
          ..selectModel('model-a')
          ..selectReasoningEffort('high');
    expect(
      await controller.submit(running: false, transcriptUserMessages: 0),
      isFalse,
    );
    final state = container
        .read(sessionComposerControllerProvider(scope))
        .requireValue;
    expect(state.model, 'model-a');
    expect(state.reasoningEffort, 'high');
  });

  test(
    'selection edits during a gated send do not retain submitted text',
    () async {
      final gate = Completer<void>();
      final repository = _FakeFollowupRepository(
        draft: 'first',
        pending: const [],
        submissionGate: gate,
      );
      final container = ProviderContainer(
        overrides: [followupRepositoryProvider.overrideWithValue(repository)],
      );
      addTearDown(container.dispose);
      await container.read(sessionComposerControllerProvider(scope).future);
      final controller = container.read(
        sessionComposerControllerProvider(scope).notifier,
      );
      final first = controller.submit(
        running: false,
        transcriptUserMessages: 0,
      );
      controller.selectModel('model-b');
      gate.complete();
      expect(await first, isTrue);
      var state = container
          .read(sessionComposerControllerProvider(scope))
          .requireValue;
      expect(state.draft, isEmpty);
      expect(state.model, 'model-b');
      controller.updateDraft('second');
      expect(
        await controller.submit(running: false, transcriptUserMessages: 0),
        isTrue,
      );
      expect(repository.submissions.map((item) => item.prompt), [
        'first',
        'second',
      ]);
      expect(repository.submissions.last.model, 'model-b');
    },
  );

  test(
    'known catalogs drop a restored invalid effort before follow-up',
    () async {
      final repository = _FakeFollowupRepository(
        draft: 'send',
        pending: const [],
        draftState: const ComposerDraftState(
          text: 'send',
          model: 'model-a',
          reasoningEffort: 'high',
        ),
        catalog: const ModelsCatalog(
          defaultAgent: 'codex',
          providers: [
            ModelProvider(
              agent: 'codex',
              label: 'Codex',
              models: [
                ModelCatalogOption(
                  id: 'model-a',
                  label: 'A',
                  reasoningEfforts: [],
                ),
              ],
              reasoningEfforts: [],
            ),
          ],
        ),
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
      container
          .read(
            sessionDetailsSnapshotProvider(
              const SessionDetailsScope(
                workspaceId: 'workspace',
                peonId: 'peon',
                sessionId: 'session',
              ),
            ).notifier,
          )
          .publish(
            const SessionDetails(
              turnCount: 0,
              agent: 'codex',
              model: 'model-a',
            ),
          );
      await container
          .read(sessionComposerControllerProvider(scope).notifier)
          .submit(running: false, transcriptUserMessages: 0);
      expect(repository.submissions.single.reasoningEffort, isNull);
    },
  );

  test('catalog failure keeps the draft visible and retries once', () async {
    final scheduler = ManualAppScheduler();
    final repository = _FakeFollowupRepository(
      draft: 'cached first',
      pending: const [],
      catalogErrors: [StateError('offline')],
      catalog: const ModelsCatalog(providers: []),
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
    final state = await container.read(
      sessionComposerControllerProvider(scope).future,
    );
    expect(state.draft, 'cached first');
    await Future<void>.delayed(Duration.zero);
    expect(scheduler.pendingDelays, contains(const Duration(seconds: 5)));
    await scheduler.advance(const Duration(seconds: 5));
    expect(repository.catalogCalls, 2);
  });

  test(
    'queued draft saves finish after disposal without reading ref',
    () async {
      final gate = Completer<void>();
      final repository = _FakeFollowupRepository(
        draft: '',
        pending: const [],
        saveGate: gate,
      );
      final container = ProviderContainer(
        overrides: [followupRepositoryProvider.overrideWithValue(repository)],
      );
      await container.read(sessionComposerControllerProvider(scope).future);
      container.read(sessionComposerControllerProvider(scope).notifier)
        ..selectModel('model-a')
        ..selectReasoningEffort('high');
      container.dispose();
      gate.complete();
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(repository.savedDraftState?.reasoningEffort, 'high');
    },
  );

  test('a failed draft save does not block the next edit', () async {
    final repository = _FakeFollowupRepository(
      draft: '',
      pending: const [],
      saveFailures: 1,
    );
    final container = ProviderContainer(
      overrides: [followupRepositoryProvider.overrideWithValue(repository)],
    );
    addTearDown(container.dispose);
    await container.read(sessionComposerControllerProvider(scope).future);
    container.read(sessionComposerControllerProvider(scope).notifier)
      ..selectModel('model-a')
      ..selectReasoningEffort('high');
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);
    expect(repository.savedDraftState?.reasoningEffort, 'high');
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
      expect(
        container
            .read(activeSessionsProvider)
            .forWorkspace(scope.workspaceId)
            ?.contains(peonId: scope.peonId, sessionId: scope.sessionId),
        isTrue,
      );

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
    expect(repository.savedDraft, 'do not lose me');
    expect(
      container
              .read(activeSessionsProvider)
              .forWorkspace(scope.workspaceId)
              ?.contains(peonId: scope.peonId, sessionId: scope.sessionId) ??
          false,
      isFalse,
    );
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

  for (final creating in [false, true]) {
    test(
      'acceptance persists after leaving the ${creating ? 'new' : 'existing'} session',
      () async {
        final target = FollowupScope(
          workspaceId: 'workspace',
          peonId: 'peon',
          sessionId: creating ? 'new-session' : 'session',
        );
        final gate = Completer<void>();
        final followups = _FakeFollowupRepository(
          draft: 'send',
          pending: const [],
          submissionGate: gate,
        );
        final sessions = _FakeNewSessionRepository(submissionGate: gate);
        final container = ProviderContainer(
          overrides: [
            followupRepositoryProvider.overrideWithValue(followups),
            newSessionRepositoryProvider.overrideWithValue(sessions),
          ],
        );
        addTearDown(container.dispose);
        final subscription = container.listen(
          sessionComposerControllerProvider(target),
          (_, _) {},
        );
        await container.read(sessionComposerControllerProvider(target).future);
        final controller =
            container.read(sessionComposerControllerProvider(target).notifier)
              ..selectModel('model-a')
              ..selectReasoningEffort('high');
        final Future<Object?> submission = creating
            ? controller.startSession()
            : controller.submit(running: false, transcriptUserMessages: 0);
        subscription.close();
        await container.pump();
        gate.complete();
        expect(await submission, isNotNull);
        expect(followups.savedDraftState?.isEmpty, isTrue);
      },
    );
  }

  test('creation retry keeps selection and ID after catalog arrival', () async {
    const target = FollowupScope(
      workspaceId: 'workspace',
      peonId: 'peon',
      sessionId: 'new-session',
    );
    final followups = _FakeFollowupRepository(draft: 'send', pending: const []);
    final sessions = _FakeNewSessionRepository(failures: 1);
    final container = ProviderContainer(
      overrides: [
        followupRepositoryProvider.overrideWithValue(followups),
        newSessionRepositoryProvider.overrideWithValue(sessions),
      ],
    );
    addTearDown(container.dispose);
    final subscription = container.listen(
      sessionComposerControllerProvider(target),
      (_, _) {},
    );
    addTearDown(subscription.close);
    await container.read(sessionComposerControllerProvider(target).future);
    final controller =
        container.read(sessionComposerControllerProvider(target).notifier)
          ..selectAgent('codex')
          ..selectModel('model-a')
          ..selectReasoningEffort('high');
    expect(await controller.startSession(), isNull);
    followups.catalog = const ModelsCatalog(
      defaultAgent: 'codex',
      providers: [
        ModelProvider(
          agent: 'codex',
          label: 'Codex',
          models: [
            ModelCatalogOption(id: 'model-a', label: 'A', reasoningEfforts: []),
          ],
          reasoningEfforts: [],
        ),
      ],
    );
    await controller.refreshCatalog();
    expect(await controller.startSession(), isNotNull);
    expect(sessions.requests.last.requestId, sessions.requests.first.requestId);
    expect(sessions.requests.last.reasoningEffort, 'high');
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
    this.draftState,
    this.catalogErrors = const [],
    this.catalog,
    this.saveGate,
    this.saveFailures = 0,
  });

  final String draft;
  final List<PendingFollowup> pending;
  final List<QueuedFollowup> queue;
  final List<Object?> refreshErrors;
  final List<FollowupException> submitErrors;
  final List<bool> retryResults;
  final Completer<void>? submissionGate;
  final ComposerDraftState? draftState;
  final List<Object> catalogErrors;
  ModelsCatalog? catalog;
  final Completer<void>? saveGate;
  final int saveFailures;
  final List<_SubmissionRecord> submissions = [];
  String? savedDraft;
  ComposerDraftState? savedDraftState;
  String? editedItemId;
  String? editedPrompt;
  int refreshCalls = 0;
  int retryCalls = 0;
  int catalogCalls = 0;
  int saveCalls = 0;

  @override
  Future<ComposerDraftState> loadDraft(FollowupScope scope) async =>
      draftState ?? ComposerDraftState(text: draft);

  @override
  Future<void> saveDraft(FollowupScope scope, ComposerDraftState draft) async {
    await saveGate?.future;
    if (saveCalls++ < saveFailures) throw StateError('disk unavailable');
    savedDraft = draft.text;
    savedDraftState = draft;
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
    String prompt, {
    SelectedTextReply? replyTo,
  }) async {
    editedItemId = itemId;
    editedPrompt = prompt;
  }

  @override
  Future<void> removeQueued(FollowupScope scope, String itemId) async {}

  @override
  Future<void> steerQueued(FollowupScope scope, String itemId) async {}

  @override
  Future<ModelsCatalog?> fetchModelCatalog(FollowupScope scope) async {
    final error = catalogCalls < catalogErrors.length
        ? catalogErrors[catalogCalls]
        : null;
    catalogCalls++;
    if (error != null) throw error;
    return catalog;
  }

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
  }) async {
    submissions.add(
      _SubmissionRecord(
        prompt: prompt,
        commandId: commandId,
        serverQueue: serverQueue,
        startNow: startNow,
        model: model,
        reasoningEffort: reasoningEffort,
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
    required this.prompt,
    required this.commandId,
    required this.serverQueue,
    required this.startNow,
    required this.model,
    required this.reasoningEffort,
  });

  final String prompt;
  final String? commandId;
  final bool serverQueue;
  final bool startNow;
  final String? model;
  final String? reasoningEffort;
}

class _FakeNewSessionRepository implements NewSessionRepository {
  _FakeNewSessionRepository({this.failures = 0, this.submissionGate});

  final int failures;
  final Completer<void>? submissionGate;
  NewSessionRequest? request;
  final List<NewSessionRequest> requests = [];

  @override
  Future<SessionSummary> createSession(NewSessionRequest request) async {
    this.request = request;
    requests.add(request);
    await submissionGate?.future;
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
