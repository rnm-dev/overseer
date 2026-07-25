import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/live/active_sessions.dart';
import 'package:overseer_mobile/core/live_activities/session_activity.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';

void main() {
  const auth = AuthSession(
    token: 'token',
    user: OperatorIdentity(email: 'viktor.ten@me.com', githubLogin: 'vibze'),
  );

  test('publishes only running sessions initiated by the operator', () async {
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
      authSession: auth,
      activeSessions: state,
      now: DateTime.fromMillisecondsSinceEpoch(1_700_000_020_000),
    );

    expect(service.calls, hasLength(1));
    expect(service.calls.single.map((activity) => activity.sessionId), [
      'mine-by-email',
      'mine-by-login',
    ]);
    expect(service.calls.single.first.title, 'Build Live Activities');
    expect(service.calls.single.first.activeCount, 2);
    expect(
      service.calls.single.first.startedAt,
      DateTime.fromMillisecondsSinceEpoch(1_700_000_000_000),
    );
  });

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
        authSession: auth,
        activeSessions: state,
        now: now,
      );
      await coordinator.reconcile(
        authSession: auth,
        activeSessions: state,
        now: now,
      );
      await coordinator.reconcile(
        authSession: null,
        activeSessions: state,
        now: now,
      );

      expect(service.calls, hasLength(2));
      expect(service.calls.first, hasLength(1));
      expect(service.calls.last, isEmpty);
    },
  );

  test('snapshot map carries truthful live-signal state', () {
    final snapshot = SessionActivitySnapshot(
      workspaceId: 'workspace',
      peonId: 'peon',
      sessionId: 'session',
      title: 'Build',
      phase: SessionActivityPhase.waiting,
      activeCount: 3,
      updatedAt: DateTime.fromMillisecondsSinceEpoch(2000),
    );

    expect(snapshot.toMap(), containsPair('activeCount', 3));
    expect(snapshot.toMap(), containsPair('phase', 'waiting'));
    expect(snapshot.toMap(), containsPair('updatedAt', 2000));
  });

  test(
    'registers ActivityKit tokens after auth and cleans up on sign out',
    () async {
      final activities = _TokenService();
      final remote = _RecordingRegistrationRemote();
      final registration = DefaultSessionActivityRegistrationService(
        activities,
        remote,
      );
      const token = SessionActivityPushToken(
        activityId: 'w\u0000p\u0000s',
        workspaceId: 'w',
        peonId: 'p',
        sessionId: 's',
        token: '0123456789abcdef0123456789abcdef',
      );

      activities.add(token);
      await registration.setAuthToken('auth-token');
      await Future<void>.delayed(Duration.zero);

      expect(remote.registrations, [('auth-token', token)]);

      await registration.setAuthToken(null);
      expect(remote.deletedTokens, ['auth-token']);
      await registration.dispose();
      await activities.dispose();
    },
  );
}

class _RecordingService implements SessionActivityService {
  final calls = <List<SessionActivitySnapshot>>[];

  @override
  Stream<SessionActivityPushToken> get pushTokenUpdates => const Stream.empty();

  @override
  Future<void> synchronize(List<SessionActivitySnapshot> activities) async {
    calls.add(List.unmodifiable(activities));
  }
}

class _TokenService implements SessionActivityService {
  final _tokens = StreamController<SessionActivityPushToken>.broadcast();

  @override
  Stream<SessionActivityPushToken> get pushTokenUpdates => _tokens.stream;

  void add(SessionActivityPushToken token) => _tokens.add(token);

  Future<void> dispose() => _tokens.close();

  @override
  Future<void> synchronize(List<SessionActivitySnapshot> activities) async {}
}

class _RecordingRegistrationRemote
    implements SessionActivityRegistrationRemote {
  final registrations = <(String, SessionActivityPushToken)>[];
  final deletedTokens = <String>[];

  @override
  Future<void> register({
    required String authToken,
    required SessionActivityPushToken activity,
  }) async {
    registrations.add((authToken, activity));
  }

  @override
  Future<void> deleteAll({required String authToken}) async {
    deletedTokens.add(authToken);
  }
}
