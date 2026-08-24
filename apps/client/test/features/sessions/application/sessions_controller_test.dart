import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/live/active_sessions.dart';
import 'package:overseer_mobile/features/sessions/application/sessions_controller.dart';
import 'package:overseer_mobile/features/sessions/domain/session_models.dart';
import 'package:overseer_mobile/features/sessions/domain/session_repository.dart';

void main() {
  const scope = SessionsScope(workspaceId: 'workspace', peonId: 'peon');

  test('publishes running state from the opening REST page', () async {
    final repository = _RestSessionRepository(
      page: const SessionPage(
        sessions: [
          SessionSummary(
            workspaceId: 'workspace',
            peonId: 'peon',
            sessionId: 'running-session',
            status: 'running',
            syncedAt: 10,
          ),
        ],
        total: 1,
        offset: 0,
        limit: 20,
        catalogStale: false,
      ),
    );
    final container = ProviderContainer(
      overrides: [sessionRepositoryProvider.overrideWithValue(repository)],
    );
    addTearDown(container.dispose);
    final subscription = container.listen(
      sessionsControllerProvider(scope),
      (_, _) {},
      fireImmediately: true,
    );
    addTearDown(subscription.close);

    await container.read(sessionsControllerProvider(scope).future);
    while (repository.requests == 0 ||
        container.read(activeSessionsProvider).forWorkspace('workspace') ==
            null) {
      await Future<void>.delayed(Duration.zero);
    }

    expect(
      container
          .read(activeSessionsProvider)
          .forWorkspace('workspace')
          ?.contains(peonId: 'peon', sessionId: 'running-session'),
      isTrue,
    );
  });

  test('keeps the REST state visible while a socket snapshot is reseeding', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final controller = container.read(activeSessionsProvider.notifier);

    controller.reconcileRestPage(
      workspaceId: 'workspace',
      peonId: 'peon',
      returnedSessionIds: const ['running-session'],
      runningSessions: const [
        ActiveSession(peonId: 'peon', sessionId: 'running-session'),
      ],
    );
    controller.replaceWorkspace('workspace', const []);
    controller.markUnknown('workspace');

    expect(
      container
          .read(activeSessionsProvider)
          .forWorkspace('workspace')
          ?.contains(peonId: 'peon', sessionId: 'running-session'),
      isTrue,
    );
  });

  test('hands a local running marker off to authoritative snapshots', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final controller = container.read(activeSessionsProvider.notifier);

    controller.replaceWorkspace('workspace', const []);
    controller.markRunningLocally(
      workspaceId: 'workspace',
      session: const ActiveSession(peonId: 'peon', sessionId: 'session'),
    );

    expect(
      container
          .read(activeSessionsProvider)
          .forWorkspace('workspace')
          ?.contains(peonId: 'peon', sessionId: 'session'),
      isTrue,
    );

    // An unrelated full snapshot must not erase a start that has not appeared
    // in the authoritative stream yet.
    controller.replaceWorkspace('workspace', const [
      ActiveSession(peonId: 'other', sessionId: 'other-session'),
    ]);
    expect(
      container
          .read(activeSessionsProvider)
          .forWorkspace('workspace')
          ?.contains(peonId: 'peon', sessionId: 'session'),
      isTrue,
    );

    controller.replaceWorkspace('workspace', const [
      ActiveSession(peonId: 'peon', sessionId: 'session'),
    ]);
    controller.replaceWorkspace('workspace', const []);
    expect(
      container
          .read(activeSessionsProvider)
          .forWorkspace('workspace')
          ?.contains(peonId: 'peon', sessionId: 'session'),
      isFalse,
    );
  });
}

class _RestSessionRepository implements SessionRepository {
  _RestSessionRepository({required this.page});

  final SessionPage page;
  int requests = 0;

  @override
  Future<List<SessionSummary>> loadCachedSessions({
    required String workspaceId,
    required String peonId,
  }) async => const [];

  @override
  Stream<List<SessionSummary>> watchSessions({
    required String workspaceId,
    required String peonId,
  }) => const Stream.empty();

  @override
  Future<SessionPage> fetchPage({
    required String workspaceId,
    required String peonId,
    required int offset,
    int limit = 50,
  }) async {
    requests += 1;
    return page;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
