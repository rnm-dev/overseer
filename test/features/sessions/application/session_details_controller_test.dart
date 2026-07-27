import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/sessions/application/session_details_controller.dart';
import 'package:overseer_mobile/features/sessions/application/sessions_controller.dart';
import 'package:overseer_mobile/features/sessions/domain/session_models.dart';
import 'package:overseer_mobile/features/sessions/domain/session_repository.dart';

void main() {
  test('marks attention read when session details become visible', () async {
    final repository = _RecordingSessionRepository();
    final container = ProviderContainer(
      overrides: [sessionRepositoryProvider.overrideWithValue(repository)],
    );
    addTearDown(container.dispose);

    final details = await container.read(
      sessionDetailsProvider(
        const SessionDetailsScope(
          workspaceId: 'workspace',
          peonId: 'peon',
          sessionId: 'session',
        ),
      ).future,
    );
    await pumpEventQueue();

    expect(details.turnCount, 3);
    expect(repository.readRequests, [
      (workspaceId: 'workspace', peonId: 'peon', sessionId: 'session'),
    ]);
  });

  test('read failure does not block session details', () async {
    final repository = _RecordingSessionRepository(failRead: true);
    final container = ProviderContainer(
      overrides: [sessionRepositoryProvider.overrideWithValue(repository)],
    );
    addTearDown(container.dispose);

    final details = await container.read(
      sessionDetailsProvider(
        const SessionDetailsScope(
          workspaceId: 'workspace',
          peonId: 'peon',
          sessionId: 'session',
        ),
      ).future,
    );
    await pumpEventQueue();

    expect(details.turnCount, 3);
    expect(repository.readRequests, hasLength(1));
  });
}

class _RecordingSessionRepository implements SessionRepository {
  _RecordingSessionRepository({this.failRead = false});

  final bool failRead;
  final List<({String workspaceId, String peonId, String sessionId})>
  readRequests = [];

  @override
  Future<SessionDetails> fetchDetails({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) async => const SessionDetails(turnCount: 3);

  @override
  Future<void> markSessionAttentionRead({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) async {
    readRequests.add((
      workspaceId: workspaceId,
      peonId: peonId,
      sessionId: sessionId,
    ));
    if (failRead) throw const SessionsException('offline');
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
