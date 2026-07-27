import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/app/app.dart';
import 'package:overseer_mobile/core/notifications/notification_routing.dart';
import 'package:overseer_mobile/features/auth/application/auth_controller.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';
import 'package:overseer_mobile/features/auth/domain/auth_repository.dart';
import 'package:overseer_mobile/features/sessions/application/sessions_controller.dart';
import 'package:overseer_mobile/features/sessions/domain/session_models.dart';
import 'package:overseer_mobile/features/sessions/domain/session_repository.dart';

void main() {
  testWidgets('session deep link keeps home beneath it for system back', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authRepositoryProvider.overrideWithValue(_RestoringAuthRepository()),
          sessionRepositoryProvider.overrideWithValue(
            _RecordingSessionRepository(),
          ),
        ],
        child: const OverseerMobileApp(
          navigationDestination: NotificationDestination.session(
            workspaceId: 'workspace',
            peonId: 'peon',
            sessionId: 'session',
          ),
        ),
      ),
    );

    final navigator = tester.state<NavigatorState>(find.byType(Navigator));
    expect(navigator.canPop(), isTrue);

    await tester.binding.handlePopRoute();
    await tester.pump();

    expect(navigator.canPop(), isFalse);
  });

  testWidgets('retains a notification session route through auth restoration', (
    tester,
  ) async {
    final auth = _RestoringAuthRepository();
    final sessions = _RecordingSessionRepository();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authRepositoryProvider.overrideWithValue(auth),
          sessionRepositoryProvider.overrideWithValue(sessions),
        ],
        child: const OverseerMobileApp(
          navigationDestination: NotificationDestination.session(
            workspaceId: 'workspace',
            peonId: 'peon',
            sessionId: 'session',
          ),
        ),
      ),
    );

    expect(find.byKey(const Key('fleet-loading')), findsOneWidget);
    expect(find.byKey(const Key('auth-restoring-logo')), findsNothing);

    auth.complete();
    await tester.pump();
    await tester.pump();

    expect(sessions.requestedWorkspaceId, 'workspace');
    expect(sessions.requestedPeonId, 'peon');
  });
}

class _RestoringAuthRepository implements AuthRepository {
  final _restoration = Completer<AuthSession?>();

  void complete() => _restoration.complete(
    const AuthSession(
      token: 'test-device-token',
      user: OperatorIdentity(email: 'operator@example.com'),
    ),
  );

  @override
  Future<AuthSession?> restore() => _restoration.future;

  @override
  Future<AuthSession> signIn() =>
      throw UnimplementedError('Sign-in is not used by this test.');

  @override
  Future<void> signOut() async {}
}

class _RecordingSessionRepository implements SessionRepository {
  String? requestedWorkspaceId;
  String? requestedPeonId;

  @override
  Future<List<SessionSummary>> loadCachedSessions({
    required String workspaceId,
    required String peonId,
  }) {
    requestedWorkspaceId = workspaceId;
    requestedPeonId = peonId;
    return Completer<List<SessionSummary>>().future;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
