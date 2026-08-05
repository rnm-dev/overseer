import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/live/active_sessions.dart';
import 'package:overseer_mobile/core/live/presence.dart';
import 'package:overseer_mobile/features/sessions/application/sessions_controller.dart';
import 'package:overseer_mobile/features/sessions/domain/session_models.dart';
import 'package:overseer_mobile/features/sessions/domain/session_repository.dart';
import 'package:overseer_mobile/features/sessions/presentation/session_list.dart';
import 'package:overseer_mobile/shared/design/colors.dart';
import 'package:overseer_mobile/shared/design/theme.dart';
import 'package:overseer_mobile/shared/widgets/app_markdown.dart';
import 'package:overseer_mobile/shared/widgets/sidebar_status_edge.dart';

void main() {
  testWidgets('renders independently from the mobile peon shell', (
    tester,
  ) async {
    SessionSummary? selectedSession;
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(
            _SessionListRepository([
              const SessionSummary(
                workspaceId: 'workspace',
                peonId: 'peon',
                sessionId: 'session',
                title: 'Reusable session',
                status: 'running',
                syncedAt: 1,
              ),
            ]),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: SessionList(
              workspaceId: 'workspace',
              peonId: 'peon',
              selectedSessionId: 'session',
              onSessionSelected: (session) => selectedSession = session,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Reusable session'), findsOneWidget);
    expect(find.byKey(const Key('session-session')), findsOneWidget);
    expect(find.byType(SessionList), findsOneWidget);
    final selectedMaterial = tester.widget<Material>(
      find
          .descendant(
            of: find.byKey(const Key('session-session')),
            matching: find.byType(Material),
          )
          .first,
    );
    expect(selectedMaterial.color, AppTheme.dark.hoverColor);

    ProviderScope.containerOf(
      tester.element(find.byType(SessionList)),
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
    await tester.pump();
    expect(find.byKey(const Key('session-presence-session')), findsOneWidget);
    expect(find.bySemanticsLabel('Online viewers: viewer'), findsOneWidget);

    await tester.tap(find.byKey(const Key('session-session')));
    expect(selectedSession?.sessionId, 'session');
  });

  testWidgets('renders the last message as compact inline Markdown', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(
            _SessionListRepository([
              const SessionSummary(
                workspaceId: 'workspace',
                peonId: 'peon',
                sessionId: 'markdown',
                title: 'Markdown session',
                preview: '**Fixed** with `code`\n\n- next',
                lastActivityAt: 1,
                syncedAt: 1,
              ),
            ]),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const Scaffold(
            body: SessionList(workspaceId: 'workspace', peonId: 'peon'),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final preview = tester.widget<AppMarkdownPreview>(
      find.byKey(const Key('session-preview-markdown')),
    );
    expect(preview.data, '**Fixed** with `code`\n\n- next');
    final richText = tester.widget<RichText>(
      find.descendant(
        of: find.byKey(const Key('session-preview-markdown')),
        matching: find.byType(RichText),
      ),
    );
    expect(richText.text.toPlainText(), 'Fixed with code • next');
    final inlineSpans = <InlineSpan>[];
    richText.text.visitChildren((span) {
      inlineSpans.add(span);
      return true;
    });
    expect(
      inlineSpans.whereType<TextSpan>().map(
        (span) => span.style?.backgroundColor,
      ),
      everyElement(isNull),
    );
    expect(
      tester.widget<Text>(find.text('Markdown session')).style?.fontSize,
      14,
    );
    expect(preview.style.fontSize, 10.6);
    final activity = tester.widget<Text>(
      find.byKey(const Key('session-activity-markdown')),
    );
    expect(activity.style?.fontSize, 10.6);
    expect(
      tester.getSize(find.byKey(const Key('session-markdown'))).height,
      48,
    );
  });

  testWidgets('filters cached sessions by canonical project identity', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(
            _SessionListRepository([
              const SessionSummary(
                workspaceId: 'workspace',
                peonId: 'peon',
                sessionId: 'canonical',
                title: 'Canonical project session',
                projectId: 'project-id',
                projectKey: 'old-key',
                syncedAt: 2,
              ),
              const SessionSummary(
                workspaceId: 'workspace',
                peonId: 'peon',
                sessionId: 'legacy',
                title: 'Legacy project session',
                projectKey: 'mobile',
                syncedAt: 1,
              ),
              const SessionSummary(
                workspaceId: 'workspace',
                peonId: 'peon',
                sessionId: 'other',
                title: 'Other project session',
                projectId: 'other-id',
                projectKey: 'other',
                syncedAt: 0,
              ),
            ]),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const Scaffold(
            body: SessionList(
              workspaceId: 'workspace',
              peonId: 'peon',
              projectId: 'project-id',
              projectKey: 'mobile',
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Canonical project session'), findsOneWidget);
    expect(find.text('Legacy project session'), findsOneWidget);
    expect(find.text('Other project session'), findsNothing);
  });

  testWidgets('defaults cached running sessions to an inactive edge', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(
            _SessionListRepository([
              const SessionSummary(
                workspaceId: 'workspace',
                peonId: 'peon',
                sessionId: 'cached-running',
                status: 'running',
                syncedAt: 1,
              ),
            ]),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const Scaffold(
            body: SessionList(workspaceId: 'workspace', peonId: 'peon'),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    _expectEdge(
      tester,
      'cached-running',
      SidebarStatusEdgeStyle.idle.color,
      glowing: false,
    );
  });

  testWidgets('matches every authoritative sidebar status edge and geometry', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(
            _SessionListRepository([
              const SessionSummary(
                workspaceId: 'workspace',
                peonId: 'peon',
                sessionId: 'running',
                status: 'running',
                syncedAt: 5,
              ),
              const SessionSummary(
                workspaceId: 'workspace',
                peonId: 'peon',
                sessionId: 'unread',
                status: 'completed',
                attentionUnread: true,
                syncedAt: 4,
              ),
              const SessionSummary(
                workspaceId: 'workspace',
                peonId: 'peon',
                sessionId: 'failed',
                status: 'failure',
                syncedAt: 2,
              ),
              const SessionSummary(
                workspaceId: 'workspace',
                peonId: 'peon',
                sessionId: 'idle',
                status: 'completed',
                syncedAt: 1,
              ),
            ]),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const Scaffold(
            body: SessionList(workspaceId: 'workspace', peonId: 'peon'),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    ProviderScope.containerOf(
      tester.element(find.byType(SessionList)),
    ).read(activeSessionsProvider.notifier).replaceWorkspace(
      'workspace',
      const [ActiveSession(peonId: 'peon', sessionId: 'running')],
    );
    await tester.pumpAndSettle();

    _expectEdge(tester, 'running', AppColors.felBright, glowing: true);
    _expectEdge(tester, 'unread', AppColors.forge, glowing: true);
    _expectEdge(tester, 'failed', AppColors.blood, glowing: true);
    _expectEdge(
      tester,
      'idle',
      SidebarStatusEdgeStyle.idle.color,
      glowing: false,
    );
    expect(
      tester.getSize(find.byKey(const Key('session-status-running'))),
      const Size(2, 40),
    );
    expect(
      tester.getSize(find.byKey(const Key('session-running'))).width,
      tester.view.physicalSize.width / tester.view.devicePixelRatio,
    );
  });
}

void _expectEdge(
  WidgetTester tester,
  String sessionId,
  Color color, {
  required bool glowing,
}) {
  final container = find
      .descendant(
        of: find.byKey(Key('session-status-$sessionId')),
        matching: find.byType(Container),
      )
      .first;
  final decoration =
      tester.widget<Container>(container).decoration! as BoxDecoration;
  expect(decoration.color, color);
  expect(decoration.boxShadow?.isNotEmpty ?? false, glowing);
}

class _SessionListRepository implements SessionRepository {
  const _SessionListRepository(this.sessions);

  final List<SessionSummary> sessions;

  @override
  Future<List<SessionSummary>> loadCachedSessions({
    required String workspaceId,
    required String peonId,
  }) async => sessions;

  @override
  Stream<List<SessionSummary>> watchSessions({
    required String workspaceId,
    required String peonId,
  }) => Stream.value(sessions);

  @override
  Future<SessionPage> fetchPage({
    required String workspaceId,
    required String peonId,
    required int offset,
    int limit = 50,
  }) async => SessionPage(
    sessions: sessions,
    total: sessions.length,
    offset: offset,
    limit: limit,
    catalogStale: false,
  );

  @override
  Future<SessionDetails> fetchDetails({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) async => const SessionDetails(turnCount: 0);

  @override
  Future<void> markSessionAttentionRead({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) async {}

  @override
  Future<void> cancelSession({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) async {}

  @override
  Future<void> renameSession({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String? title,
  }) async {}

  @override
  Future<void> deleteSession({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) async {}

  @override
  Future<TranscriptCache> loadCachedTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) async => const TranscriptCache(events: [], hasOlder: false);

  @override
  Stream<List<TranscriptEvent>> watchTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) => const Stream.empty();

  @override
  Future<TranscriptPage> fetchLatestTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    int limit = 50,
  }) async => const TranscriptPage(
    events: [],
    nextCursor: null,
    hasMore: false,
    insertedCount: 0,
  );

  @override
  Future<TranscriptPage> fetchOlderTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String cursor,
    int limit = 50,
  }) => fetchLatestTranscript(
    workspaceId: workspaceId,
    peonId: peonId,
    sessionId: sessionId,
    limit: limit,
  );

  @override
  Future<void> cacheTailEvent({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String eventId,
    required Map<String, dynamic> payload,
  }) async {}

  @override
  Future<int> cursorFor(String workspaceId) async => 0;

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
}
