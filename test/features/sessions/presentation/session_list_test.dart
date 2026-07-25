import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/live/presence.dart';
import 'package:overseer_mobile/features/sessions/application/sessions_controller.dart';
import 'package:overseer_mobile/features/sessions/domain/session_models.dart';
import 'package:overseer_mobile/features/sessions/domain/session_repository.dart';
import 'package:overseer_mobile/features/sessions/presentation/session_list.dart';
import 'package:overseer_mobile/shared/design/theme.dart';

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
  Future<void> cancelSession({
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
