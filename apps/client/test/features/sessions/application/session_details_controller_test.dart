import 'dart:async';

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

  test(
    'publishes refreshed model and effort as authoritative details',
    () async {
      final repository = _RecordingSessionRepository();
      final container = ProviderContainer(
        overrides: [sessionRepositoryProvider.overrideWithValue(repository)],
      );
      addTearDown(container.dispose);
      const scope = SessionDetailsScope(
        workspaceId: 'workspace',
        peonId: 'peon',
        sessionId: 'session',
      );

      await container.read(sessionDetailsProvider(scope).future);
      expect(
        container.read(sessionDetailsSnapshotProvider(scope))?.model,
        'model-a',
      );
      container
          .read(sessionDetailsSnapshotProvider(scope).notifier)
          .publish(
            const SessionDetails(
              turnCount: 4,
              model: 'model-external',
              reasoningEffort: 'high',
            ),
          );
      expect(
        container.read(sessionDetailsSnapshotProvider(scope))?.model,
        'model-external',
      );
    },
  );

  test(
    'late initial details cannot replace newer reconciled details',
    () async {
      final gate = Completer<SessionDetails>();
      final repository = _RecordingSessionRepository(detailsGate: gate);
      final container = ProviderContainer(
        overrides: [sessionRepositoryProvider.overrideWithValue(repository)],
      );
      addTearDown(container.dispose);
      const scope = SessionDetailsScope(
        workspaceId: 'workspace',
        peonId: 'peon',
        sessionId: 'session',
      );
      final listener = container.listen(
        sessionDetailsProvider(scope),
        (_, _) {},
      );
      addTearDown(listener.close);
      final initial = container.read(sessionDetailsProvider(scope).future);
      await pumpEventQueue();
      container
          .read(sessionDetailsSnapshotProvider(scope).notifier)
          .publish(const SessionDetails(turnCount: 4, model: 'model-b'));
      gate.complete(const SessionDetails(turnCount: 3, model: 'model-a'));
      await initial;
      expect(
        container.read(sessionDetailsSnapshotProvider(scope))?.model,
        'model-b',
      );
    },
  );
}

class _RecordingSessionRepository implements SessionRepository {
  _RecordingSessionRepository({this.failRead = false, this.detailsGate});

  final bool failRead;
  final Completer<SessionDetails>? detailsGate;
  final List<({String workspaceId, String peonId, String sessionId})>
  readRequests = [];

  @override
  Future<SessionDetails> fetchDetails({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) async =>
      await detailsGate?.future ??
      const SessionDetails(turnCount: 3, model: 'model-a');

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
