import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:overseer_mobile/features/fleet/application/fleet_controller.dart';
import 'package:overseer_mobile/features/fleet/domain/fleet_models.dart';
import 'package:overseer_mobile/features/fleet/domain/fleet_repository.dart';
import 'package:overseer_mobile/features/shell/shell.dart';
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
  testWidgets(
    'Windows sidebar persists across routes and pushed pages and opens overview',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1440, 900);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      final auth = _RestoringAuthRepository()..complete();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sessionRepositoryProvider.overrideWithValue(
              _RecordingSessionRepository(),
            ),
            authRepositoryProvider.overrideWithValue(auth),
            fleetRepositoryProvider.overrideWithValue(_EmptyFleetRepository()),
            fleetSidebarBuilderProvider.overrideWithValue(
              (_) => const SizedBox.shrink(),
            ),
          ],
          child: const OverseerMobileApp(),
        ),
      );
      await tester.pumpAndSettle();
      final sidebar = find.byKey(const Key('persistent-desktop-sidebar'));
      expect(sidebar, findsOneWidget);
      expect(find.byType(ShellConnectionRail), findsOneWidget);
      final resizer = find.byKey(const Key('desktop-sidebar-resizer'));
      expect(tester.getSize(sidebar).width, 232);
      await tester.drag(resizer, const Offset(800, 0));
      await tester.pumpAndSettle();
      expect(tester.getSize(sidebar).width, closeTo(1440 * .25, .01));
      tester.view.physicalSize = const Size(1000, 900);
      await tester.pumpAndSettle();
      expect(tester.getSize(sidebar).width, closeTo(1000 * .25, .01));
      tester.view.physicalSize = const Size(800, 900);
      await tester.pumpAndSettle();
      expect(resizer, findsNothing);
      expect(find.byTooltip('Projects and chats'), findsOneWidget);
      tester.view.physicalSize = const Size(1440, 900);
      await tester.pumpAndSettle();
      await tester.drag(resizer, const Offset(-800, 0));
      await tester.pumpAndSettle();
      expect(tester.getSize(sidebar).width, 208);
      await tester.drag(resizer, const Offset(100, 0));
      await tester.pumpAndSettle();
      final resizedWidth = tester.getSize(sidebar).width;
      expect(resizedWidth, greaterThan(208));
      final sidebarElement = tester.element(sidebar);
      final overviewContext = tester.element(
        find.byKey(const Key('fleet-overview')),
      );
      final router = GoRouter.of(overviewContext);
      router.pushNamed(
        'session',
        queryParameters: {
          'workspaceId': 'workspace',
          'peonId': 'peon',
          'sessionId': 'session',
        },
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(
        ProviderScope.containerOf(
          tester.element(sidebar),
        ).read(selectedSidebarChatProvider),
        (workspaceId: 'workspace', peonId: 'peon', sessionId: 'session'),
      );
      await tester.tap(find.byKey(const Key('shell-overview-navigation')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      expect(
        ProviderScope.containerOf(
          tester.element(sidebar),
        ).read(selectedSidebarChatProvider),
        isNull,
      );
      router.pushNamed(
        'peon',
        queryParameters: {'workspaceId': 'workspace', 'peonId': 'peon'},
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      expect(tester.element(sidebar), same(sidebarElement));
      expect(tester.getSize(sidebar).width, resizedWidth);
      expect(find.byKey(const ValueKey('workspace\u0000peon')), findsOneWidget);
      await tester.tap(find.byKey(const Key('shell-overview-navigation')));
      await tester.pumpAndSettle();
      expect(router.routeInformationProvider.value.uri.path, '/');
      expect(find.byKey(const Key('fleet-overview')), findsOneWidget);
      final contentContext = tester.element(
        find.byKey(const Key('fleet-overview')),
      );
      Navigator.of(contentContext).push(
        MaterialPageRoute<void>(
          builder: (_) => const Scaffold(body: Text('Creation page')),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Creation page'), findsOneWidget);
      expect(tester.element(sidebar), same(sidebarElement));
      await tester.tap(find.byKey(const Key('shell-overview-navigation')));
      await tester.pumpAndSettle();
      expect(find.text('Creation page'), findsNothing);
      expect(find.byKey(const Key('fleet-overview')), findsOneWidget);
      expect(find.byType(ShellConnectionRail), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
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

class _EmptyFleetRepository implements FleetRepository {
  @override
  Future<List<WorkspaceFleet>> loadFleet() async => const [];
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
