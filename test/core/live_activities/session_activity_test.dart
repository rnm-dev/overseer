import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/live/active_sessions.dart';
import 'package:overseer_mobile/core/live_activities/session_activity.dart';

void main() {
  const operatorIdentities = {' VIKTOR.TEN@ME.COM ', 'VIBZE'};

  test(
    'publishes one aggregate for running sessions owned by operator',
    () async {
      final service = _RecordingService();
      final coordinator = SessionActivityCoordinator(service);
      final state = ActiveSessionsState(
        authoritativeByWorkspace: {
          'workspace': ActiveWorkspaceSessions([
            const ActiveSession(
              peonId: 'peon',
              sessionId: 'mine-by-email',
              title: 'Build Live Activities',
              author: 'VIKTOR.TEN@ME.COM',
              startedAt: 1_700_000_000,
              lastActivityAt: 1_700_000_010,
            ),
            const ActiveSession(
              peonId: 'peon',
              sessionId: 'mine-by-login',
              promptPreview: 'Run tests',
              projectKey: 'overseer-mobile',
              author: 'Vibze',
            ),
            const ActiveSession(
              peonId: 'peon',
              sessionId: 'someone-else',
              title: 'Private work',
              author: 'other@example.com',
            ),
            const ActiveSession(
              peonId: 'peon',
              sessionId: 'unknown-owner',
              title: 'Legacy session',
            ),
          ]),
        },
      );

      await coordinator.reconcile(
        connectionId: 'connection',
        operatorIdentities: operatorIdentities,
        activeSessions: state,
        completedUnreadCount: 4,
        now: DateTime.fromMillisecondsSinceEpoch(1_700_000_020_000),
      );

      expect(service.calls, hasLength(1));
      expect(service.calls.single, hasLength(1));
      expect(service.calls.single.first.activityId, 'overseer:connection');
      expect(service.calls.single.first.runningCount, 2);
      expect(service.calls.single.first.completedCount, 4);
      expect(
        service.calls.single.first.oldestStartedAt,
        DateTime.fromMillisecondsSinceEpoch(1_700_000_000_000),
      );
    },
  );

  test(
    'deduplicates unchanged snapshots and clears them on sign out',
    () async {
      final service = _RecordingService();
      final coordinator = SessionActivityCoordinator(service);
      final state = ActiveSessionsState(
        authoritativeByWorkspace: {
          'workspace': ActiveWorkspaceSessions([
            const ActiveSession(
              peonId: 'peon',
              sessionId: 'session',
              title: 'Build',
              author: 'viktor.ten@me.com',
              lastActivityAt: 1_700_000_000,
            ),
          ]),
        },
      );
      final now = DateTime.fromMillisecondsSinceEpoch(1_700_000_010_000);

      await coordinator.reconcile(
        connectionId: 'connection',
        operatorIdentities: operatorIdentities,
        activeSessions: state,
        completedUnreadCount: 0,
        now: now,
      );
      await coordinator.reconcile(
        connectionId: 'connection',
        operatorIdentities: operatorIdentities,
        activeSessions: state,
        completedUnreadCount: 0,
        now: now,
      );
      await coordinator.reconcile(
        connectionId: 'connection',
        operatorIdentities: const {},
        activeSessions: state,
        completedUnreadCount: 0,
        now: now,
      );

      expect(service.calls, hasLength(2));
      expect(service.calls.first, hasLength(1));
      expect(service.calls.last, isEmpty);
    },
  );

  test('snapshot map carries aggregate live-signal state', () {
    final snapshot = SessionActivitySnapshot(
      connectionId: 'connection',
      runningCount: 3,
      completedCount: 2,
      oldestStartedAt: DateTime.fromMillisecondsSinceEpoch(1000),
      updatedAt: DateTime.fromMillisecondsSinceEpoch(2000),
    );

    expect(snapshot.toMap(), containsPair('runningCount', 3));
    expect(snapshot.toMap(), containsPair('completedCount', 2));
    expect(snapshot.toMap(), containsPair('oldestStartedAt', 1000));
    expect(snapshot.toMap(), containsPair('updatedAt', 2000));
  });

  test(
    'registers ActivityKit start and update tokens after auth and cleans up',
    () async {
      final activities = _TokenService();
      final remote = _RecordingRegistrationRemote();
      final registration = DefaultSessionActivityRegistrationService(
        activities,
        remote,
        connectionId: 'connection',
      );
      const token = SessionActivityPushToken(
        activityId: 'activity-kit-id',
        connectionId: 'connection',
        token: '0123456789abcdef0123456789abcdef',
      );
      const pushToStart = SessionActivityPushToStartToken(
        token: 'abcdef0123456789abcdef0123456789',
      );

      activities.add(token);
      activities.addPushToStart(pushToStart);
      await registration.setAuthToken('auth-token');
      await Future<void>.delayed(Duration.zero);

      expect(remote.registrations, [('auth-token', token)]);
      expect(remote.pushToStartRegistrations, [
        ('auth-token', 'connection', pushToStart),
      ]);

      await registration.setAuthToken(null);
      expect(remote.deletedTokens, ['auth-token']);
      await registration.dispose();
      await activities.dispose();
    },
  );

  testWidgets('loads the current ActivityKit push-to-start token', (
    tester,
  ) async {
    const channel = MethodChannel('test/session-activities');
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async {
      if (call.method == 'getPushToStartToken') {
        return 'abcdef0123456789abcdef0123456789';
      }
      return null;
    });
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        null,
      ),
    );
    final service = MethodChannelSessionActivityService(channel: channel);

    final token = await service.pushToStartTokenUpdates.first;

    expect(token.token, 'abcdef0123456789abcdef0123456789');
    await service.dispose();
  });
}

class _RecordingService implements SessionActivityService {
  final calls = <List<SessionActivitySnapshot>>[];

  @override
  Stream<SessionActivityPushToken> get pushTokenUpdates => const Stream.empty();

  @override
  Stream<SessionActivityPushToStartToken> get pushToStartTokenUpdates =>
      const Stream.empty();

  @override
  Future<void> synchronize({
    required String connectionId,
    required List<SessionActivitySnapshot> activities,
  }) async {
    calls.add(List.unmodifiable(activities));
  }
}

class _TokenService implements SessionActivityService {
  final _tokens = StreamController<SessionActivityPushToken>.broadcast();
  final _pushToStartTokens =
      StreamController<SessionActivityPushToStartToken>.broadcast();

  @override
  Stream<SessionActivityPushToken> get pushTokenUpdates => _tokens.stream;

  @override
  Stream<SessionActivityPushToStartToken> get pushToStartTokenUpdates =>
      _pushToStartTokens.stream;

  void add(SessionActivityPushToken token) => _tokens.add(token);
  void addPushToStart(SessionActivityPushToStartToken token) =>
      _pushToStartTokens.add(token);

  Future<void> dispose() async {
    await _tokens.close();
    await _pushToStartTokens.close();
  }

  @override
  Future<void> synchronize({
    required String connectionId,
    required List<SessionActivitySnapshot> activities,
  }) async {}
}

class _RecordingRegistrationRemote
    implements SessionActivityRegistrationRemote {
  final registrations = <(String, SessionActivityPushToken)>[];
  final pushToStartRegistrations =
      <(String, String, SessionActivityPushToStartToken)>[];
  final deletedTokens = <String>[];

  @override
  Future<void> register({
    required String authToken,
    required SessionActivityPushToken activity,
  }) async {
    registrations.add((authToken, activity));
  }

  @override
  Future<void> registerPushToStart({
    required String authToken,
    required String connectionId,
    required SessionActivityPushToStartToken token,
  }) async {
    pushToStartRegistrations.add((authToken, connectionId, token));
  }

  @override
  Future<void> deleteAll({required String authToken}) async {
    deletedTokens.add(authToken);
  }
}
