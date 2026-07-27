import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/live/active_sessions.dart';
import 'package:overseer_mobile/core/live/presence.dart';
import 'package:overseer_mobile/features/projects/application/projects_controller.dart';
import 'package:overseer_mobile/features/projects/domain/project_detail_models.dart';
import 'package:overseer_mobile/features/projects/domain/project_models.dart';
import 'package:overseer_mobile/features/projects/domain/project_repository.dart';
import 'package:overseer_mobile/features/sessions/application/attachment_clipboard_provider.dart';
import 'package:overseer_mobile/features/sessions/application/session_details_controller.dart';
import 'package:overseer_mobile/features/sessions/application/session_composer_controller.dart';
import 'package:overseer_mobile/features/sessions/application/transcript_controller.dart';
import 'package:overseer_mobile/features/sessions/application/sessions_controller.dart';
import 'package:overseer_mobile/features/sessions/domain/attachment_clipboard.dart';
import 'package:overseer_mobile/features/sessions/domain/followup_repository.dart';
import 'package:overseer_mobile/features/sessions/domain/new_session_repository.dart';
import 'package:overseer_mobile/features/sessions/domain/session_models.dart';
import 'package:overseer_mobile/features/sessions/domain/session_repository.dart';
import 'package:overseer_mobile/features/sessions/presentation/session_detail_page.dart';
import 'package:overseer_mobile/shared/design/colors.dart';
import 'package:overseer_mobile/shared/design/theme.dart';
import 'package:overseer_mobile/shared/models/ai_capabilities.dart';
import 'package:overseer_mobile/shared/widgets/app_navigation_bar.dart';
import 'package:overseer_mobile/shared/widgets/presence_stack.dart';

void main() {
  testWidgets('centers a short project selection in the available space', (
    tester,
  ) async {
    final projects = List.generate(
      2,
      (index) => PeonProject(
        workspaceId: 'workspace',
        peonId: 'peon',
        projectId: 'project-$index',
        key: 'project-key-$index',
        name: 'Project ${index + 1}',
        syncedAt: 1,
      ),
    );
    await tester.binding.setSurfaceSize(const Size(400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          projectRepositoryProvider.overrideWithValue(
            _TestProjectRepository(projects),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const SessionDetailPage.newSession(
            workspaceId: 'workspace',
            peonId: 'peon',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final selectionCenter =
        (tester
                .getTopLeft(find.byKey(const Key('new-session-project-title')))
                .dy +
            tester
                .getBottomLeft(
                  find.byKey(const Key('new-session-project-project-1')),
                )
                .dy) /
        2;
    final availableCenter =
        (tester.getBottomLeft(find.byKey(const Key('session-navbar'))).dy +
            tester
                .getTopLeft(find.byKey(const Key('session-composer-gradient')))
                .dy) /
        2;

    expect(selectionCenter, closeTo(availableCenter, 5));
    expect(
      tester.getCenter(find.byKey(const Key('new-session-project-title'))).dx,
      closeTo(200, 0.5),
    );
    final selectionFinder = find.byKey(
      const Key('new-session-project-selection'),
    );
    final composerFinder = find.byKey(const Key('session-composer-gradient'));
    final projectScroll = tester.widget<SingleChildScrollView>(
      find.byKey(const Key('new-session-project-scroll')),
    );

    expect(
      tester.getBottomLeft(selectionFinder).dy,
      tester.getBottomLeft(composerFinder).dy,
    );
    expect(
      (projectScroll.padding! as EdgeInsets).bottom,
      closeTo(tester.getSize(composerFinder).height + 24, 0.5),
    );
  });

  testWidgets(
    'centers project choices, scrolls long catalogs, and submits the selection',
    (tester) async {
      final projects = List.generate(
        14,
        (index) => PeonProject(
          workspaceId: 'workspace',
          peonId: 'peon',
          projectId: 'project-$index',
          key: 'project-key-$index',
          name: 'Project ${index + 1}',
          syncedAt: 1,
        ),
      );
      final newSessions = _RecordingNewSessionRepository();
      await tester.binding.setSurfaceSize(const Size(400, 600));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            followupRepositoryProvider.overrideWithValue(
              const _TestFollowupRepository(),
            ),
            projectRepositoryProvider.overrideWithValue(
              _TestProjectRepository(projects),
            ),
            newSessionRepositoryProvider.overrideWithValue(newSessions),
          ],
          child: MaterialApp(
            theme: AppTheme.dark,
            home: const SessionDetailPage.newSession(
              workspaceId: 'workspace',
              peonId: 'peon',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Select a project'), findsOneWidget);
      expect(find.byKey(const Key('new-session-empty-title')), findsNothing);
      expect(
        tester.getCenter(find.byKey(const Key('new-session-project-title'))).dx,
        closeTo(200, 0.5),
      );

      final lastProject = find.byKey(
        const Key('new-session-project-project-13'),
      );
      expect(lastProject.hitTestable(), findsNothing);
      await tester.scrollUntilVisible(
        lastProject,
        280,
        scrollable: find.descendant(
          of: find.byKey(const Key('new-session-project-selection')),
          matching: find.byType(Scrollable),
        ),
      );
      expect(lastProject.hitTestable(), findsOneWidget);

      await tester.tap(lastProject);
      await tester.pump();
      await tester.enterText(
        find.byKey(const Key('session-composer-input')),
        'Work in the selected project',
      );
      await tester.pump();
      expect(
        tester
            .widget<IconButton>(
              find.byKey(const Key('session-composer-submit')),
            )
            .onPressed,
        isNotNull,
      );
      await tester.tap(find.byKey(const Key('session-composer-submit')));
      await tester.pumpAndSettle();

      expect(newSessions.request?.projectKey, 'project-key-13');
    },
  );

  testWidgets(
    'keeps the submitted surface stable until the created session is ready',
    (tester) async {
      final creation = Completer<SessionSummary>();
      final transcript = Completer<TranscriptState>();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            followupRepositoryProvider.overrideWithValue(
              const _TestFollowupRepository(),
            ),
            newSessionRepositoryProvider.overrideWithValue(
              _PendingNewSessionRepository(creation.future),
            ),
            projectRepositoryProvider.overrideWithValue(
              _TestProjectRepository(),
            ),
            transcriptControllerProvider.overrideWith2(
              (scope) => _PendingTranscriptController(scope, transcript.future),
            ),
          ],
          child: MaterialApp(
            theme: AppTheme.dark,
            home: const SessionDetailPage.newSession(
              workspaceId: 'workspace',
              peonId: 'peon',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('session-composer-input')),
        'Keep this screen steady',
      );
      await tester.pump();
      await tester.tap(find.byKey(const Key('session-composer-submit')));
      await tester.pump();

      creation.complete(
        const SessionSummary(
          workspaceId: 'workspace',
          peonId: 'peon',
          sessionId: 'created-session',
          status: 'running',
          title: 'Keep this screen steady',
          syncedAt: 1,
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(find.text('New session'), findsOneWidget);
      expect(
        find.byKey(const Key('new-session-project-selection')),
        findsOneWidget,
      );
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('session-composer-input')))
            .controller
            ?.text,
        'Keep this screen steady',
      );
      expect(find.text('Starting session…'), findsOneWidget);

      transcript.complete(
        TranscriptState(
          events: [
            TranscriptEvent(
              eventId: 'user-message',
              orderKey: 1,
              payload: const {
                'type': 'user_message',
                'text': 'Keep this screen steady',
              },
            ),
          ],
          isRunning: false,
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(find.text('New session'), findsNothing);
      expect(
        find.byKey(const Key('new-session-project-selection')),
        findsNothing,
      );
      expect(find.text('Keep this screen steady'), findsWidgets);
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('session-composer-input')))
            .controller
            ?.text,
        isEmpty,
      );
    },
  );

  testWidgets('offers file picking and clipboard paste for a new session', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          followupRepositoryProvider.overrideWithValue(
            const _TestFollowupRepository(),
          ),
          attachmentClipboardProvider.overrideWithValue(
            const _TestAttachmentClipboard(),
          ),
          projectRepositoryProvider.overrideWithValue(_TestProjectRepository()),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const SessionDetailPage.newSession(
            workspaceId: 'workspace',
            peonId: 'peon',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('session-composer-attach')));
    await tester.pumpAndSettle();

    expect(find.text('Add attachments'), findsOneWidget);
    expect(
      find.byKey(const Key('session-attachment-choose-files')),
      findsOneWidget,
    );
    expect(find.byKey(const Key('session-attachment-paste')), findsOneWidget);
    expect(find.text('Paste from clipboard'), findsOneWidget);

    await tester.tap(find.byKey(const Key('session-attachment-paste')));
    await tester.pumpAndSettle();

    expect(find.text('pasted.png'), findsOneWidget);
  });

  testWidgets('pastes and submits attachments in an existing session', (
    tester,
  ) async {
    final followups = _RecordingFollowupRepository();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          followupRepositoryProvider.overrideWithValue(followups),
          attachmentClipboardProvider.overrideWithValue(
            const _TestAttachmentClipboard(),
          ),
          transcriptControllerProvider.overrideWith2(
            (scope) => _TestTranscriptController(
              scope,
              const TranscriptState(events: []),
            ),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const SessionDetailPage(
            session: SessionSummary(
              workspaceId: 'workspace',
              peonId: 'peon',
              sessionId: 'session',
              title: 'Existing session',
              syncedAt: 1,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('session-composer-attach')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('session-attachment-paste')));
    await tester.pumpAndSettle();
    expect(find.text('pasted.png'), findsOneWidget);

    await tester.tap(find.byKey(const Key('session-composer-submit')));
    await tester.pumpAndSettle();

    expect(followups.attachments.single.name, 'pasted.png');
    expect(followups.prompt, isEmpty);
    expect(followups.commandId, isNotEmpty);
    expect(find.text('pasted.png'), findsNothing);
  });

  testWidgets('enforces follow-up clipboard count and size limits', (
    tester,
  ) async {
    final clipboard = _LimitAttachmentClipboard();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          followupRepositoryProvider.overrideWithValue(
            const _TestFollowupRepository(),
          ),
          attachmentClipboardProvider.overrideWithValue(clipboard),
          transcriptControllerProvider.overrideWith2(
            (scope) => _TestTranscriptController(
              scope,
              const TranscriptState(events: []),
            ),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const SessionDetailPage(
            session: SessionSummary(
              workspaceId: 'workspace',
              peonId: 'peon',
              sessionId: 'session',
              title: 'Existing session',
              syncedAt: 1,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('session-composer-attach')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('session-attachment-paste')));
    await tester.pumpAndSettle();

    expect(clipboard.availableFiles, 10);
    expect(clipboard.maxBytes, 25 * 1024 * 1024);
    expect(find.textContaining('25 MB or smaller'), findsOneWidget);
    expect(find.textContaining('2 files were not added'), findsOneWidget);
  });

  testWidgets('reads URI-only keyboard image insertion', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          followupRepositoryProvider.overrideWithValue(
            const _TestFollowupRepository(),
          ),
          attachmentClipboardProvider.overrideWithValue(
            const _TestAttachmentClipboard(),
          ),
          projectRepositoryProvider.overrideWithValue(_TestProjectRepository()),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const SessionDetailPage.newSession(
            workspaceId: 'workspace',
            peonId: 'peon',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final field = tester.widget<TextField>(
      find.byKey(const Key('session-composer-input')),
    );
    field.contentInsertionConfiguration!.onContentInserted(
      const KeyboardInsertedContent(
        mimeType: 'image/png',
        uri: 'content://clipboard/image',
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('inserted.png'), findsOneWidget);
    expect(find.text('The pasted image could not be read.'), findsNothing);
  });

  testWidgets('releases attachment data after a session starts', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          followupRepositoryProvider.overrideWithValue(
            const _TestFollowupRepository(),
          ),
          attachmentClipboardProvider.overrideWithValue(
            const _TestAttachmentClipboard(),
          ),
          newSessionRepositoryProvider.overrideWithValue(
            const _TestNewSessionRepository(),
          ),
          projectRepositoryProvider.overrideWithValue(_TestProjectRepository()),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const SessionDetailPage.newSession(
            workspaceId: 'workspace',
            peonId: 'peon',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('session-composer-attach')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('session-attachment-paste')));
    await tester.pumpAndSettle();
    expect(find.text('pasted.png'), findsOneWidget);

    await tester.tap(find.byKey(const Key('session-composer-submit')));
    await tester.pumpAndSettle();

    expect(find.text('pasted.png'), findsNothing);
  });

  testWidgets('shows cached stats immediately while details refresh', (
    tester,
  ) async {
    final details = Completer<SessionDetails>();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionDetailsProvider.overrideWith((ref, scope) => details.future),
          transcriptControllerProvider.overrideWith2(
            (scope) => _TestTranscriptController(
              scope,
              TranscriptState(
                events: [
                  TranscriptEvent(
                    eventId: 'result-1',
                    orderKey: 0,
                    payload: const {
                      'type': 'result',
                      'num_turns': 2,
                      'usage': {'input_tokens': 900, 'output_tokens': 321},
                    },
                  ),
                ],
              ),
            ),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const SessionDetailPage(
            session: SessionSummary(
              workspaceId: 'workspace',
              peonId: 'peon',
              sessionId: 'session',
              projectKey: 'overseer-mobile',
              title: 'Build the session screen',
              syncedAt: 1,
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    final titleTopBefore = tester
        .getTopLeft(find.byKey(const Key('session-title')))
        .dy;
    expect(find.byKey(const Key('session-stats-shimmer')), findsNothing);
    expect(find.text('2 turns·900 input·321 output'), findsOneWidget);
    expect(
      tester.getSize(find.byKey(const Key('session-stats-slot'))).height,
      12,
    );

    details.complete(
      const SessionDetails(
        turnCount: 3,
        usage: SessionUsage(
          inputTokens: 1200,
          outputTokens: 456,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('session-stats-shimmer')), findsNothing);
    expect(find.text('3 turns·1.2K input·456 output'), findsOneWidget);
    expect(
      tester.getSize(find.byKey(const Key('session-stats-slot'))).height,
      12,
    );
    expect(
      tester.getTopLeft(find.byKey(const Key('session-title'))).dy,
      titleTopBefore,
    );
  });

  testWidgets('keeps an empty stats slot when no cached stats exist', (
    tester,
  ) async {
    final details = Completer<SessionDetails>();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionDetailsProvider.overrideWith((ref, scope) => details.future),
          transcriptControllerProvider.overrideWith2(
            (scope) => _TestTranscriptController(
              scope,
              const TranscriptState(events: []),
            ),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const SessionDetailPage(
            session: SessionSummary(
              workspaceId: 'workspace',
              peonId: 'peon',
              sessionId: 'session',
              title: 'New session',
              syncedAt: 1,
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.byKey(const Key('session-stats-shimmer')), findsNothing);
    expect(find.byKey(const Key('session-stats')), findsNothing);
    expect(
      tester.getSize(find.byKey(const Key('session-stats-slot'))).height,
      12,
    );
  });

  testWidgets('matches the web session identity in the shared mobile navbar', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionDetailsProvider.overrideWith(
            (ref, scope) async => const SessionDetails(
              turnCount: 3,
              usage: SessionUsage(
                inputTokens: 1200,
                outputTokens: 456,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
              ),
            ),
          ),
          transcriptControllerProvider.overrideWith2(
            (scope) => _TestTranscriptController(
              scope,
              const TranscriptState(events: []),
            ),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const SessionDetailPage(
            session: SessionSummary(
              workspaceId: 'workspace',
              peonId: 'peon',
              sessionId: 'session',
              projectKey: 'overseer-mobile',
              title: 'Build the session screen',
              syncedAt: 1,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final navigationBar = tester.widget<AppNavigationBar>(
      find.byKey(const Key('session-navbar')),
    );
    expect(navigationBar.showBackButton, isTrue);
    expect(
      navigationBar.contentPadding,
      const EdgeInsets.fromLTRB(8, 10, 8, 6),
    );

    ProviderScope.containerOf(
      tester.element(find.byType(SessionDetailPage)),
    ).read(presenceProvider.notifier).replaceWorkspace('workspace', const [
      PresenceEntry(
        userId: 'viewer',
        email: 'viewer@example.test',
        githubLogin: 'viewer',
        scope: PresenceScope.session,
        peonId: 'peon',
        sessionId: 'session',
      ),
    ]);
    await tester.pumpAndSettle();
    final floatingPresence = find.byKey(const Key('session-floating-presence'));
    expect(floatingPresence, findsOneWidget);
    expect(find.bySemanticsLabel('Online viewers: viewer'), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(const Key('session-navbar')),
        matching: find.byType(PresenceStack),
      ),
      findsNothing,
    );
    expect(tester.getSize(floatingPresence), const Size(28, 28));
    expect(
      tester.getTopLeft(floatingPresence).dy,
      tester.getBottomLeft(find.byKey(const Key('session-navbar'))).dy + 12,
    );
    expect(
      tester.getTopRight(floatingPresence).dx,
      tester.view.physicalSize.width / tester.view.devicePixelRatio - 14,
    );
    expect(find.byKey(const Key('session-files')), findsOneWidget);
    expect(find.byTooltip('Open project files'), findsOneWidget);
    expect(tester.getSize(find.byKey(const Key('session-navbar'))).height, 56);

    final title = tester.widget<Text>(find.byKey(const Key('session-title')));
    final titleSpan = title.textSpan! as TextSpan;
    expect(
      titleSpan.toPlainText(),
      'Overseer Mobile  Build the session screen',
    );
    expect(title.overflow, TextOverflow.fade);
    expect(
      (titleSpan.children!.first as TextSpan).style?.color,
      AppColors.forge,
    );
    expect(find.text('3 turns·1.2K input·456 output'), findsOneWidget);
  });

  testWidgets('falls back to the cached session display title', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionDetailsProvider.overrideWith(
            (ref, scope) async => const SessionDetails(turnCount: 0),
          ),
          transcriptControllerProvider.overrideWith2(
            (scope) => _TestTranscriptController(
              scope,
              const TranscriptState(events: []),
            ),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const SessionDetailPage(
            session: SessionSummary(
              workspaceId: 'workspace',
              peonId: 'peon',
              sessionId: 'session',
              promptPreview: 'Opening request',
              syncedAt: 1,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final title = tester.widget<Text>(find.byKey(const Key('session-title')));
    expect(title.textSpan?.toPlainText(), 'Opening request');
    expect(find.byKey(const Key('session-stats')), findsNothing);
  });

  testWidgets('keeps fast transcript loading invisible', (tester) async {
    final transcript = Completer<TranscriptState>();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionDetailsProvider.overrideWith(
            (ref, scope) async => const SessionDetails(turnCount: 0),
          ),
          transcriptControllerProvider.overrideWith2(
            (scope) => _PendingTranscriptController(scope, transcript.future),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const SessionDetailPage(
            session: SessionSummary(
              workspaceId: 'workspace',
              peonId: 'peon',
              sessionId: 'session',
              title: 'Fast transcript',
              syncedAt: 1,
            ),
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 200));

    expect(
      tester
          .widget<AnimatedOpacity>(
            find.byKey(const Key('transcript-loading-opacity')),
          )
          .opacity,
      0,
    );

    transcript.complete(const TranscriptState(events: []));
    await tester.pumpAndSettle();

    expect(find.text('No transcript yet.'), findsOneWidget);
    expect(
      tester
          .widget<AnimatedOpacity>(
            find.byKey(const Key('transcript-loading-opacity')),
          )
          .opacity,
      0,
    );
  });

  testWidgets('slides the loading pill in after a delay and back out', (
    tester,
  ) async {
    final transcript = Completer<TranscriptState>();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionDetailsProvider.overrideWith(
            (ref, scope) async => const SessionDetails(turnCount: 0),
          ),
          transcriptControllerProvider.overrideWith2(
            (scope) => _PendingTranscriptController(scope, transcript.future),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const SessionDetailPage(
            session: SessionSummary(
              workspaceId: 'workspace',
              peonId: 'peon',
              sessionId: 'session',
              title: 'Slow transcript',
              syncedAt: 1,
            ),
          ),
        ),
      ),
    );

    await tester.pump(const Duration(milliseconds: 1999));
    expect(
      tester
          .widget<AnimatedOpacity>(
            find.byKey(const Key('transcript-loading-opacity')),
          )
          .opacity,
      0,
    );

    await tester.pump(const Duration(milliseconds: 1));
    await tester.pump(const Duration(milliseconds: 420));

    expect(find.text('Loading messages…'), findsOneWidget);
    expect(find.byType(BackdropFilter), findsOneWidget);
    expect(
      tester
          .widget<AnimatedOpacity>(
            find.byKey(const Key('transcript-loading-opacity')),
          )
          .opacity,
      1,
    );
    expect(
      tester
          .widget<AnimatedSlide>(
            find.byKey(const Key('transcript-loading-slide')),
          )
          .offset,
      Offset.zero,
    );

    transcript.complete(const TranscriptState(events: []));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 320));

    expect(
      tester
          .widget<AnimatedOpacity>(
            find.byKey(const Key('transcript-loading-opacity')),
          )
          .opacity,
      0,
    );
    expect(
      tester
          .widget<AnimatedSlide>(
            find.byKey(const Key('transcript-loading-slide')),
          )
          .offset,
      const Offset(0, -1.5),
    );
  });

  testWidgets('renders cached transcript newest-first from the bottom', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionDetailsProvider.overrideWith(
            (ref, scope) async => const SessionDetails(turnCount: 1),
          ),
          transcriptControllerProvider.overrideWith2(
            (scope) => _TestTranscriptController(
              scope,
              TranscriptState(
                hasOlder: true,
                events: [
                  TranscriptEvent(
                    eventId: 'event-1',
                    orderKey: 0,
                    payload: const {
                      'eventId': 'event-1',
                      'type': 'user_message',
                      'text': 'Please inspect the cache',
                    },
                  ),
                  TranscriptEvent(
                    eventId: 'event-2',
                    orderKey: 1,
                    payload: const {
                      'eventId': 'event-2',
                      'type': 'assistant',
                      'message': {
                        'content': [
                          {'type': 'text', 'text': 'Cache is ready'},
                        ],
                      },
                    },
                  ),
                ],
              ),
            ),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const SessionDetailPage(
            session: SessionSummary(
              workspaceId: 'workspace',
              peonId: 'peon',
              sessionId: 'session',
              title: 'Cached transcript',
              syncedAt: 1,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('transcript-list')), findsOneWidget);
    expect(find.text('Please inspect the cache'), findsOneWidget);
    expect(find.text('Cache is ready'), findsOneWidget);
    expect(find.text('Load older events'), findsOneWidget);
  });

  testWidgets('only follows transcript updates while already at the bottom', (
    tester,
  ) async {
    final controller = _TestTranscriptController(
      const TranscriptScope(
        workspaceId: 'workspace',
        peonId: 'peon',
        sessionId: 'session',
      ),
      TranscriptState(events: _transcriptEvents(30)),
    );
    await tester.binding.setSurfaceSize(const Size(400, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionDetailsProvider.overrideWith(
            (ref, scope) async => const SessionDetails(turnCount: 1),
          ),
          transcriptControllerProvider.overrideWith2((scope) => controller),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const SessionDetailPage(
            session: SessionSummary(
              workspaceId: 'workspace',
              peonId: 'peon',
              sessionId: 'session',
              title: 'Live transcript',
              syncedAt: 1,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final list = find.byKey(const Key('transcript-list'));
    final scrollable = tester.state<ScrollableState>(
      find.descendant(of: list, matching: find.byType(Scrollable)).first,
    );
    expect(scrollable.position.pixels, 0);

    controller.emit(TranscriptState(events: _transcriptEvents(31)));
    await tester.pump();
    await tester.pump();
    expect(scrollable.position.pixels, 0);

    await tester.drag(list, const Offset(0, 300));
    await tester.pumpAndSettle();
    final scrolledUpOffset = scrollable.position.pixels;
    expect(scrolledUpOffset, greaterThan(24));

    controller.emit(TranscriptState(events: _transcriptEvents(32)));
    await tester.pump();
    await tester.pump();
    expect(scrollable.position.pixels, closeTo(scrolledUpOffset, 0.5));
  });

  testWidgets(
    'floats the composer over the transcript with dynamic tail padding',
    (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            followupRepositoryProvider.overrideWithValue(
              const _TestFollowupRepository(),
            ),
            sessionDetailsProvider.overrideWith(
              (ref, scope) async => const SessionDetails(turnCount: 1),
            ),
            transcriptControllerProvider.overrideWith2(
              (scope) => _TestTranscriptController(
                scope,
                TranscriptState(
                  events: [
                    TranscriptEvent(
                      eventId: 'event-1',
                      orderKey: 0,
                      payload: const {
                        'eventId': 'event-1',
                        'type': 'user_message',
                        'text': 'Composer overlay target',
                      },
                    ),
                  ],
                ),
              ),
            ),
          ],
          child: MaterialApp(
            theme: AppTheme.dark,
            home: const SessionDetailPage(
              session: SessionSummary(
                workspaceId: 'workspace',
                peonId: 'peon',
                sessionId: 'session',
                title: 'Floating composer',
                syncedAt: 1,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final listFinder = find.byKey(const Key('transcript-list'));
      final composerFinder = find.byKey(const Key('session-composer-gradient'));
      final collapsedHeight = tester.getSize(composerFinder).height;
      final collapsedPadding =
          (tester.widget<ListView>(listFinder).padding! as EdgeInsets).bottom;

      expect(
        tester.getBottomLeft(listFinder).dy,
        tester.getBottomLeft(composerFinder).dy,
      );
      expect(collapsedPadding, closeTo(collapsedHeight + 4, 0.5));

      await tester.enterText(
        find.byKey(const Key('session-composer-input')),
        'one\ntwo\nthree\nfour\nfive',
      );
      await tester.pump();
      await tester.pump();

      final expandedHeight = tester.getSize(composerFinder).height;
      final expandedPadding =
          (tester.widget<ListView>(listFinder).padding! as EdgeInsets).bottom;
      expect(expandedHeight, greaterThan(collapsedHeight));
      expect(expandedPadding, greaterThan(collapsedPadding));
      expect(expandedPadding, closeTo(expandedHeight + 4, 0.5));
    },
  );

  testWidgets('shows contextual working activity at the transcript tail', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionDetailsProvider.overrideWith(
            (ref, scope) async =>
                const SessionDetails(turnCount: 1, status: 'running'),
          ),
          transcriptControllerProvider.overrideWith2(
            (scope) => _TestTranscriptController(
              scope,
              TranscriptState(
                isRunning: true,
                events: [
                  ..._transcriptEvents(20),
                  TranscriptEvent(
                    eventId: 'bash-event',
                    orderKey: 20,
                    payload: const {
                      'eventId': 'bash-event',
                      'type': 'assistant',
                      'message': {
                        'content': [
                          {
                            'type': 'tool_use',
                            'name': 'Bash',
                            'input': {'command': 'flutter test'},
                          },
                        ],
                      },
                    },
                  ),
                ],
              ),
            ),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const SessionDetailPage(
            session: SessionSummary(
              workspaceId: 'workspace',
              peonId: 'peon',
              sessionId: 'session',
              status: 'running',
              title: 'Running transcript',
              syncedAt: 1,
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.byKey(const Key('transcript-working')), findsOneWidget);
    expect(find.text('Running a command…'), findsOneWidget);
    expect(find.text('· 0:00'), findsOneWidget);
    expect(
      find.bySemanticsLabel('Agent working: Running a command…'),
      findsOneWidget,
    );
    expect(find.byKey(const Key('transcript-stop')), findsOneWidget);
    expect(find.text('Stop'), findsOneWidget);
    final label = tester.widget<Text>(
      find.byKey(const Key('transcript-working-label')),
    );
    final duration = tester.widget<Text>(
      find.byKey(const Key('transcript-working-duration')),
    );
    expect(label.style?.fontSize, 10);
    expect(label.style?.color, AppColors.felBright);
    expect(duration.style?.fontSize, 10);
    expect(duration.style?.color, AppColors.boneFaint);
    expect(
      find.byKey(const Key('transcript-working-flow-bash-event')),
      findsOneWidget,
    );
    await tester.drag(
      find.byKey(const Key('transcript-list')),
      const Offset(0, 180),
    );
    await tester.pump();
    expect(find.byKey(const Key('transcript-working')), findsNothing);

    await tester.drag(
      find.byKey(const Key('transcript-list')),
      const Offset(0, -1000),
    );
    await tester.pump(const Duration(milliseconds: 500));
    expect(
      find.byKey(const Key('transcript-working-flow-bash-event')),
      findsOneWidget,
    );
  });

  testWidgets('stops a running session from the thinking row', (tester) async {
    final cancel = Completer<void>();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(
            _CancelSessionRepository(() => cancel.future),
          ),
          sessionDetailsProvider.overrideWith(
            (ref, scope) async =>
                const SessionDetails(turnCount: 1, status: 'running'),
          ),
          transcriptControllerProvider.overrideWith2(
            (scope) => _TestTranscriptController(
              scope,
              TranscriptState(
                isRunning: true,
                events: [
                  TranscriptEvent(
                    eventId: 'thinking',
                    orderKey: 0,
                    payload: const {'type': 'thinking', 'text': 'Working'},
                  ),
                ],
              ),
            ),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const SessionDetailPage(
            session: SessionSummary(
              workspaceId: 'workspace',
              peonId: 'peon',
              sessionId: 'session',
              status: 'running',
              title: 'Running transcript',
              syncedAt: 1,
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    await tester.tap(find.byKey(const Key('transcript-stop')));
    await tester.pump();
    expect(find.text('Stopping…'), findsOneWidget);
    expect(
      tester
          .widget<TextButton>(find.byKey(const Key('transcript-stop')))
          .onPressed,
      isNull,
    );

    cancel.complete();
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('transcript-working')), findsNothing);
  });

  testWidgets(
    'shows Stop when the authoritative live snapshot marks the session active',
    (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sessionDetailsProvider.overrideWith(
              (ref, scope) async =>
                  const SessionDetails(turnCount: 1, status: 'idle'),
            ),
            transcriptControllerProvider.overrideWith2(
              (scope) => _TestTranscriptController(
                scope,
                const TranscriptState(isRunning: false, events: []),
              ),
            ),
          ],
          child: MaterialApp(
            theme: AppTheme.dark,
            home: const SessionDetailPage(
              session: SessionSummary(
                workspaceId: 'workspace',
                peonId: 'peon',
                sessionId: 'session',
                status: 'idle',
                title: 'Live running transcript',
                syncedAt: 1,
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(find.byKey(const Key('transcript-stop')), findsNothing);

      final container = ProviderScope.containerOf(
        tester.element(find.byType(SessionDetailPage)),
      );
      container.read(activeSessionsProvider.notifier).replaceWorkspace(
        'workspace',
        const [ActiveSession(peonId: 'peon', sessionId: 'session')],
      );
      expect(
        container
            .read(activeSessionsProvider)
            .forWorkspace('workspace')
            ?.contains(peonId: 'peon', sessionId: 'session'),
        isTrue,
      );
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 100));

      expect(find.byKey(const Key('transcript-working')), findsOneWidget);
      expect(find.byKey(const Key('transcript-stop')), findsOneWidget);
    },
  );
}

class _TestTranscriptController extends TranscriptController {
  _TestTranscriptController(super.scope, this.initial);

  final TranscriptState initial;

  @override
  Future<TranscriptState> build() async => initial;

  @override
  Future<void> refresh() async {}

  @override
  Future<void> loadOlder() async {}

  void emit(TranscriptState next) {
    state = AsyncData(next);
  }
}

List<TranscriptEvent> _transcriptEvents(int count) => List.generate(
  count,
  (index) => TranscriptEvent(
    eventId: 'event-$index',
    orderKey: index,
    payload: {
      'eventId': 'event-$index',
      'type': 'user_message',
      'text': 'Transcript message $index with enough text to fill a row.',
    },
  ),
);

class _PendingTranscriptController extends TranscriptController {
  _PendingTranscriptController(super.scope, this.pending);

  final Future<TranscriptState> pending;

  @override
  Future<TranscriptState> build() => pending;
}

class _TestFollowupRepository implements FollowupRepository {
  const _TestFollowupRepository();

  @override
  Future<ModelsCatalog?> fetchModelCatalog(FollowupScope scope) async => null;

  @override
  Future<String> loadDraft(FollowupScope scope) async => '';

  @override
  Future<void> saveDraft(FollowupScope scope, String text) async {}

  @override
  Stream<List<PendingFollowup>> watchPending(FollowupScope scope) =>
      Stream.value(const []);

  @override
  Stream<List<QueuedFollowup>> watchQueue(FollowupScope scope) =>
      Stream.value(const []);

  @override
  Future<void> refreshQueue(FollowupScope scope) async {}

  @override
  Future<void> editQueued(
    FollowupScope scope,
    String itemId,
    String prompt,
  ) async {}

  @override
  Future<void> removeQueued(FollowupScope scope, String itemId) async {}

  @override
  Future<void> sendQueuedNow(FollowupScope scope, String itemId) async {}

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
  }) async => FollowupDelivery.delivered;

  @override
  Future<bool> retryPending(FollowupScope scope) async => false;
}

class _TestAttachmentClipboard implements AttachmentClipboard {
  const _TestAttachmentClipboard();

  @override
  Future<ClipboardAttachmentResult> read({
    required int availableFiles,
    required int maxBytes,
  }) async {
    return ClipboardAttachmentResult(
      attachments: [
        ClipboardAttachment(
          name: 'pasted.png',
          type: 'image',
          bytes: Uint8List.fromList([1, 2, 3]),
        ),
      ],
    );
  }

  @override
  Future<ClipboardAttachmentResult> readInsertedContent({
    required String uri,
    required String mimeType,
    required int maxBytes,
  }) async {
    return ClipboardAttachmentResult(
      attachments: [
        ClipboardAttachment(
          name: 'inserted.png',
          type: 'image',
          bytes: Uint8List.fromList([4, 5, 6]),
        ),
      ],
    );
  }
}

class _LimitAttachmentClipboard implements AttachmentClipboard {
  int? availableFiles;
  int? maxBytes;

  @override
  Future<ClipboardAttachmentResult> read({
    required int availableFiles,
    required int maxBytes,
  }) async {
    this.availableFiles = availableFiles;
    this.maxBytes = maxBytes;
    return const ClipboardAttachmentResult(
      skippedTooLarge: 1,
      skippedForLimit: 2,
    );
  }

  @override
  Future<ClipboardAttachmentResult> readInsertedContent({
    required String uri,
    required String mimeType,
    required int maxBytes,
  }) async => const ClipboardAttachmentResult();
}

class _RecordingFollowupRepository extends _TestFollowupRepository {
  String? prompt;
  String? commandId;
  List<NewSessionAttachment> attachments = const [];

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
    this.prompt = prompt;
    this.commandId = commandId;
    this.attachments = attachments;
    onProgress?.call(const FollowupSubmissionProgress.submitting());
    return FollowupDelivery.delivered;
  }
}

class _TestNewSessionRepository implements NewSessionRepository {
  const _TestNewSessionRepository();

  @override
  Future<SessionSummary> createSession(NewSessionRequest request) async {
    return const SessionSummary(
      workspaceId: 'workspace',
      peonId: 'peon',
      sessionId: 'created-session',
      title: '(see attachments)',
      syncedAt: 1,
    );
  }
}

class _PendingNewSessionRepository implements NewSessionRepository {
  const _PendingNewSessionRepository(this.pending);

  final Future<SessionSummary> pending;

  @override
  Future<SessionSummary> createSession(NewSessionRequest request) => pending;
}

class _RecordingNewSessionRepository implements NewSessionRepository {
  NewSessionRequest? request;

  @override
  Future<SessionSummary> createSession(NewSessionRequest request) async {
    this.request = request;
    return SessionSummary(
      workspaceId: request.workspaceId,
      peonId: request.peonId,
      sessionId: 'created-session',
      projectKey: request.projectKey,
      title: request.prompt,
      syncedAt: 1,
    );
  }
}

class _TestProjectRepository implements ProjectRepository {
  _TestProjectRepository([this.projects = const []]);

  final List<PeonProject> projects;

  @override
  Future<List<PeonProject>> loadCachedProjects({
    required String workspaceId,
    required String peonId,
  }) async => projects;

  @override
  Stream<List<PeonProject>> watchProjects({
    required String workspaceId,
    required String peonId,
  }) => Stream.value(projects);

  @override
  Future<ProjectSnapshot> refreshProjects({
    required String workspaceId,
    required String peonId,
  }) async => ProjectSnapshot(
    projects: projects,
    catalog: const ProjectCatalog(state: 'ready', stale: false),
  );

  @override
  Future<ProjectSuggestion> suggestProject({
    required String workspaceId,
    required String peonId,
    required String label,
  }) async => const ProjectSuggestion();

  @override
  Future<void> createProject({
    required String workspaceId,
    required String peonId,
    required String label,
    String? dir,
    String? metadata,
  }) async {}

  @override
  Future<ProjectDirectory> fetchDirectory({
    required String workspaceId,
    required String peonId,
    required String projectKey,
    required String path,
  }) async => ProjectDirectory(path: path, entries: const []);

  @override
  Future<ProjectFilePreview> fetchFile({
    required String workspaceId,
    required String peonId,
    required String projectKey,
    required String path,
  }) => throw UnimplementedError();

  @override
  Future<void> advanceCursor({
    required String workspaceId,
    required int cursor,
  }) async {}

  @override
  Future<void> applyLiveProjection({
    required String workspaceId,
    required int cursor,
    required Map<String, dynamic> projection,
  }) async {}

  @override
  Future<int> cursorFor(String workspaceId) async => 0;
}

class _CancelSessionRepository implements SessionRepository {
  _CancelSessionRepository(this.cancel);

  final Future<void> Function() cancel;

  @override
  Future<void> cancelSession({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) {
    return cancel();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
