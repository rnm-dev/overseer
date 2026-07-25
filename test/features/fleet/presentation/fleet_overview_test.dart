import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/live/active_sessions.dart';
import 'package:overseer_mobile/core/live/presence.dart';
import 'package:overseer_mobile/core/live/live_projection_sink.dart';
import 'package:overseer_mobile/core/notifications/notification_permission.dart';
import 'package:overseer_mobile/features/fleet/application/fleet_controller.dart';
import 'package:overseer_mobile/features/fleet/application/fleet_live_service.dart';
import 'package:overseer_mobile/features/fleet/domain/fleet_models.dart';
import 'package:overseer_mobile/features/fleet/domain/fleet_repository.dart';
import 'package:overseer_mobile/features/fleet/presentation/fleet_overview.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';
import 'package:overseer_mobile/shared/design/theme.dart';
import 'package:overseer_mobile/shared/design/motion.dart';
import 'package:overseer_mobile/shared/design/typography.dart';
import 'package:overseer_mobile/shared/widgets/app_button.dart';
import 'package:overseer_mobile/shared/widgets/overseer_logo.dart';
import 'package:overseer_mobile/shared/widgets/surface.dart';

void main() {
  testWidgets('shows workspaces, peons, presence, and active sessions', (
    tester,
  ) async {
    final live = _FakeFleetLiveService();
    await _pump(
      tester,
      _FakeFleetRepository(
        result: const [
          WorkspaceFleet(
            workspace: Workspace(id: 'rnm', name: 'RNM'),
            peons: [
              Peon(
                id: 'kanat',
                name: 'Kanat',
                online: true,
                lastSeen: 100,
                capabilities: [],
                load: PeonLoad(activeSessions: 2),
              ),
              Peon(
                id: 'thor',
                name: 'Thor',
                online: false,
                lastSeen: 50,
                capabilities: [],
              ),
            ],
          ),
        ],
      ),
      live: live,
    );
    await tester.pump();

    expect(find.text('RNM'), findsOneWidget);
    expect(find.text('Kanat'), findsOneWidget);
    expect(find.text('2 active'), findsOneWidget);
    expect(find.text('Thor'), findsOneWidget);
    expect(find.text('offline'), findsOneWidget);
    expect(
      tester
          .widget<Padding>(find.byKey(const Key('fleet-screen-padding')))
          .padding,
      const EdgeInsets.fromLTRB(8, 18, 8, 48),
    );
    expect(
      tester.getSize(find.byType(OverseerLogo)),
      const Size.square(OverseerLogo.splashExtent),
    );

    final workspaceCard = tester.widget<Surface>(
      find.byKey(const Key('workspace-rnm')),
    );
    final settingsCard = tester.widget<Surface>(
      find.byKey(const Key('settings-card')),
    );
    expect(settingsCard.padding, workspaceCard.padding);
    expect(settingsCard.borderRadius, workspaceCard.borderRadius);
    expect(
      tester.getSize(find.byKey(const Key('sound-setting'))).height,
      tester.getSize(find.byKey(const Key('peon-kanat'))).height,
    );

    final kanatNode = tester.widget<InkWell>(
      find.byKey(const Key('peon-kanat')),
    );
    final material = tester.widget<Material>(
      find
          .ancestor(
            of: find.byWidget(kanatNode),
            matching: find.byType(Material),
          )
          .first,
    );
    expect(material.color, isNot(AppTheme.dark.scaffoldBackgroundColor));

    live.emitActiveSessions('rnm', 'kanat', 3);
    await tester.pump();
    expect(find.text('3 active'), findsOneWidget);

    live.emitPresence('rnm', const [
      PresenceEntry(
        userId: 'viewer',
        email: 'viewer@example.test',
        githubLogin: 'viewer',
        scope: PresenceScope.session,
        peonId: 'kanat',
        sessionId: 'session',
      ),
    ]);
    await tester.pump();
    expect(find.byKey(const Key('peon-presence-kanat')), findsOneWidget);
    expect(find.bySemanticsLabel('Online viewers: viewer'), findsOneWidget);
    expect(find.byKey(const Key('peon-presence-thor')), findsNothing);
  });

  testWidgets('shows loading and empty states', (tester) async {
    final result = Completer<List<WorkspaceFleet>>();
    await _pump(tester, _FakeFleetRepository(pending: result.future));

    expect(find.byKey(const Key('fleet-loading')), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);

    result.complete(const []);
    await tester.pump();

    expect(find.text('No workspaces available'), findsOneWidget);
    expect(find.text('dev@example.com'), findsOneWidget);
  });

  testWidgets('resumes live updates and applies session projections', (
    tester,
  ) async {
    final live = _FakeFleetLiveService();
    final sink = _FakeLiveProjectionSink(cursor: 41);
    final projectSink = _FakeLiveProjectionSink(cursor: 41);
    await _pump(
      tester,
      _FakeFleetRepository(
        result: const [
          WorkspaceFleet(
            workspace: Workspace(id: 'rnm', name: 'RNM'),
            peons: [],
          ),
        ],
      ),
      live: live,
      sink: sink,
      projectSink: projectSink,
    );
    await tester.pump();

    expect(live.initialCursors, {'rnm': 41});
    await live.emitSession('rnm', 42, {
      'peonId': 'kanat',
      'sessionId': 'session',
      'lastActivityAt': 100,
      'syncedAt': 100,
    });
    await live.emitCursor('rnm', 43);
    await live.emitProject('rnm', 44, {
      'peonId': 'kanat',
      'projectId': 'project',
      'key': 'overseer-mobile',
      'syncedAt': 100,
    });

    expect(sink.projections.single.cursor, 42);
    expect(sink.projections.single.projection['sessionId'], 'session');
    expect(sink.cursor, 43);
    expect(projectSink.projections.single.cursor, 44);
    expect(projectSink.projections.single.projection['projectId'], 'project');

    live.emitActiveSessionSnapshot('rnm', const [
      ActiveSession(
        peonId: 'kanat',
        sessionId: 'active-session',
        projectId: 'project',
        projectKey: 'overseer-mobile',
      ),
    ]);
    await tester.pump();
    final container = ProviderScope.containerOf(
      tester.element(find.byType(FleetOverview)),
    );
    final active = container.read(activeSessionsProvider).forWorkspace('rnm');
    expect(
      active?.contains(peonId: 'kanat', sessionId: 'active-session'),
      isTrue,
    );
    expect(
      active?.countForProject(
        peonId: 'kanat',
        projectId: 'project',
        projectKey: 'overseer-mobile',
      ),
      1,
    );
  });

  testWidgets('shows the current user and signs out', (tester) async {
    var signedOut = false;
    await _pump(
      tester,
      _FakeFleetRepository(),
      onSignOut: () async => signedOut = true,
    );
    await tester.pump();

    expect(find.byKey(const Key('user-card')), findsOneWidget);
    expect(find.text('dev@example.com'), findsOneWidget);

    final userCard = find.byKey(const Key('user-card'));
    await tester.ensureVisible(userCard);
    await tester.pumpAndSettle();
    await tester.tap(userCard);
    await tester.pumpAndSettle();

    expect(find.text('Sign out?'), findsOneWidget);
    expect(signedOut, isFalse);
    final titleFinder = find.text('Sign out?');
    final title = tester.widget<Text>(titleFinder);
    expect(title.style, AppTypography.sectionTitle());
    final confirmButton = tester.widget<AppButton>(
      find.byKey(const Key('confirmation-confirm')),
    );
    final cancelButton = tester.widget<AppButton>(
      find.byKey(const Key('confirmation-cancel')),
    );
    expect(confirmButton.variant, AppButtonVariant.danger);
    expect(cancelButton.variant, AppButtonVariant.secondary);
    expect(confirmButton.borderRadius, AppMotion.optionShape);
    expect(cancelButton.borderRadius, AppMotion.optionShape);

    await tester.tap(find.byKey(const Key('confirmation-confirm')));
    await tester.pumpAndSettle();
    expect(signedOut, isTrue);
  });

  testWidgets('offers the four compact sound pack choices', (tester) async {
    await _pump(tester, _FakeFleetRepository());
    await tester.pump();

    expect(find.text('Settings'), findsOneWidget);
    expect(find.text('Sounds'), findsOneWidget);
    expect(find.text('Peon'), findsOneWidget);
    expect(find.text('Language'), findsNothing);

    final soundSetting = find.byKey(const Key('sound-setting'));
    await tester.ensureVisible(soundSetting);
    await tester.pumpAndSettle();
    await tester.tap(soundSetting);
    await tester.pumpAndSettle();

    expect(find.text('Peon'), findsNWidgets(2));
    expect(find.text('SCV'), findsOneWidget);
    expect(find.text('Peasant'), findsOneWidget);
    expect(find.text('Mute'), findsOneWidget);

    await tester.tap(find.text('SCV'));
    await tester.pumpAndSettle();

    expect(find.text('SCV'), findsOneWidget);
    expect(find.text('Peon'), findsNothing);
  });

  testWidgets('offers system settings when notification prompt stays denied', (
    tester,
  ) async {
    final permissions = _FakeNotificationPermissionGateway(
      current: NotificationPermissionStatus.denied,
    );
    await _pump(
      tester,
      _FakeFleetRepository(),
      notificationPermissions: permissions,
    );
    await tester.pumpAndSettle();

    final notificationSetting = find.byKey(const Key('notification-setting'));
    await tester.ensureVisible(notificationSetting);
    await tester.pumpAndSettle();
    expect(find.text('Notifications'), findsOneWidget);

    await tester.tap(find.byKey(const Key('notification-toggle')));
    await tester.pumpAndSettle();

    expect(permissions.requestCount, 1);
    expect(find.text('Enable notifications'), findsOneWidget);
    expect(find.text('Open system settings'), findsOneWidget);
    expect(
      tester
          .widget<Text>(find.byKey(const Key('notification-settings-title')))
          .textAlign,
      TextAlign.center,
    );
    expect(
      tester
          .widget<Text>(
            find.byKey(const Key('notification-settings-description')),
          )
          .textAlign,
      TextAlign.center,
    );
    final settingsButton = tester.widget<AppButton>(
      find.byKey(const Key('open-notification-settings')),
    );
    expect(settingsButton.size, AppButtonSize.lg);
    expect(settingsButton.borderRadius, AppMotion.optionShape);

    await tester.tap(find.byKey(const Key('open-notification-settings')));
    await tester.pumpAndSettle();
    expect(permissions.openSettingsCount, 1);
    expect(find.text('Enable notifications'), findsNothing);
  });

  testWidgets('shows repository errors and retries', (tester) async {
    final repository = _FakeFleetRepository(
      error: const FleetException('Network unavailable'),
    );
    await _pump(tester, repository);
    await tester.pumpAndSettle();

    expect(find.text('Network unavailable'), findsOneWidget);

    repository
      ..error = null
      ..result = const [];
    await tester.tap(find.byKey(const Key('fleet-retry')));
    await tester.pumpAndSettle();

    expect(repository.loadCount, 2);
    expect(find.text('No workspaces available'), findsOneWidget);
  });
}

Future<void> _pump(
  WidgetTester tester,
  FleetRepository repository, {
  FleetLiveService? live,
  LiveProjectionSink? sink,
  LiveProjectionSink? projectSink,
  NotificationPermissionGateway? notificationPermissions,
  Future<void> Function()? onSignOut,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        fleetRepositoryProvider.overrideWithValue(repository),
        if (live != null) fleetLiveServiceProvider.overrideWithValue(live),
        if (sink != null) liveProjectionSinkProvider.overrideWithValue(sink),
        if (projectSink != null)
          projectLiveProjectionSinkProvider.overrideWithValue(projectSink),
        if (notificationPermissions != null)
          notificationPermissionGatewayProvider.overrideWithValue(
            notificationPermissions,
          ),
      ],
      child: MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: FleetOverview(
            compact: true,
            user: const OperatorIdentity(email: 'dev@example.com'),
            onSignOut: onSignOut ?? _signOut,
          ),
        ),
      ),
    ),
  );
}

Future<void> _signOut() async {}

class _FakeNotificationPermissionGateway
    implements NotificationPermissionGateway {
  _FakeNotificationPermissionGateway({required this.current});

  NotificationPermissionStatus current;
  int requestCount = 0;
  int openSettingsCount = 0;

  @override
  Future<bool> openSettings() async {
    openSettingsCount += 1;
    return true;
  }

  @override
  Future<NotificationPermissionStatus> request() async {
    requestCount += 1;
    return current;
  }

  @override
  Future<NotificationPermissionStatus> status() async => current;
}

class _FakeFleetLiveService implements FleetLiveService {
  void Function(String, String, int)? _onActiveSessions;
  void Function(String, List<ActiveSession>?)? _onActiveSessionSnapshot;
  Future<void> Function(String, int, Map<String, dynamic>)? _onSession;
  Future<void> Function(String, int, Map<String, dynamic>)? _onProject;
  Future<void> Function(String, int)? _onCursor;
  void Function(String, List<PresenceEntry>)? _onPresence;
  Map<String, int>? initialCursors;

  @override
  Future<void> connect({
    required List<String> workspaceIds,
    required Map<String, int> initialCursors,
    required void Function(String, Map<String, dynamic>) onPeon,
    required Future<void> Function(
      String workspaceId,
      int cursor,
      Map<String, dynamic> session,
    )
    onSession,
    required Future<void> Function(
      String workspaceId,
      int cursor,
      Map<String, dynamic> project,
    )
    onProject,
    required Future<void> Function(String workspaceId, int cursor) onCursor,
    required void Function(String, String, int) onActiveSessions,
    required void Function(String, List<ActiveSession>?)
    onActiveSessionSnapshot,
    required void Function(String, List<PresenceEntry>) onPresence,
  }) async {
    this.initialCursors = initialCursors;
    _onActiveSessions = onActiveSessions;
    _onActiveSessionSnapshot = onActiveSessionSnapshot;
    _onSession = onSession;
    _onProject = onProject;
    _onCursor = onCursor;
    _onPresence = onPresence;
  }

  void emitPresence(String workspaceId, List<PresenceEntry> presence) {
    _onPresence?.call(workspaceId, presence);
  }

  @override
  void setPresence({
    required String workspaceId,
    required PresenceLocation location,
  }) {}

  void emitActiveSessionSnapshot(
    String workspaceId,
    List<ActiveSession> sessions,
  ) {
    _onActiveSessionSnapshot?.call(workspaceId, sessions);
  }

  void emitActiveSessions(String workspaceId, String peonId, int count) {
    _onActiveSessions?.call(workspaceId, peonId, count);
  }

  Future<void> emitSession(
    String workspaceId,
    int cursor,
    Map<String, dynamic> session,
  ) async {
    await _onSession?.call(workspaceId, cursor, session);
  }

  Future<void> emitProject(
    String workspaceId,
    int cursor,
    Map<String, dynamic> project,
  ) async {
    await _onProject?.call(workspaceId, cursor, project);
  }

  Future<void> emitCursor(String workspaceId, int cursor) async {
    await _onCursor?.call(workspaceId, cursor);
  }

  @override
  Future<void> stop() async {}
}

class _FakeLiveProjectionSink implements LiveProjectionSink {
  _FakeLiveProjectionSink({required this.cursor});

  int cursor;
  final List<_AppliedProjection> projections = [];

  @override
  Future<void> applyLiveProjection({
    required String workspaceId,
    required int cursor,
    required Map<String, dynamic> projection,
  }) async {
    projections.add(
      _AppliedProjection(
        workspaceId: workspaceId,
        cursor: cursor,
        projection: projection,
      ),
    );
    if (cursor > this.cursor) this.cursor = cursor;
  }

  @override
  Future<void> advanceCursor({
    required String workspaceId,
    required int cursor,
  }) async {
    if (cursor > this.cursor) this.cursor = cursor;
  }

  @override
  Future<int> cursorFor(String workspaceId) async => cursor;
}

class _AppliedProjection {
  const _AppliedProjection({
    required this.workspaceId,
    required this.cursor,
    required this.projection,
  });

  final String workspaceId;
  final int cursor;
  final Map<String, dynamic> projection;
}

class _FakeFleetRepository implements FleetRepository {
  _FakeFleetRepository({this.result = const [], this.error, this.pending});

  List<WorkspaceFleet> result;
  Object? error;
  final Future<List<WorkspaceFleet>>? pending;
  int loadCount = 0;

  @override
  Future<List<WorkspaceFleet>> loadFleet() async {
    loadCount++;
    if (pending != null) return pending!;
    if (error case final error?) throw error;
    return result;
  }
}
