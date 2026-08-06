import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/live/active_sessions.dart';
import 'package:overseer_mobile/features/fleet/domain/fleet_models.dart';
import 'package:overseer_mobile/features/peon/presentation/peon_home_page.dart';
import 'package:overseer_mobile/features/projects/application/projects_controller.dart';
import 'package:overseer_mobile/features/projects/domain/project_detail_models.dart';
import 'package:overseer_mobile/features/projects/domain/project_models.dart';
import 'package:overseer_mobile/features/projects/domain/project_repository.dart';
import 'package:overseer_mobile/features/sessions/application/sessions_controller.dart';
import 'package:overseer_mobile/features/sessions/domain/session_models.dart';
import 'package:overseer_mobile/features/sessions/domain/session_repository.dart';
import 'package:overseer_mobile/features/sessions/presentation/session_detail_page.dart';
import 'package:overseer_mobile/features/sessions/presentation/session_list.dart';
import 'package:overseer_mobile/shared/design/colors.dart';
import 'package:overseer_mobile/shared/design/theme.dart';
import 'package:overseer_mobile/shared/design/typography.dart';
import 'package:overseer_mobile/shared/widgets/app_navigation_bar.dart';
import 'package:overseer_mobile/shared/widgets/app_option_bottom_sheet.dart';
import 'package:overseer_mobile/shared/widgets/sidebar_status_edge.dart';

Widget _testPeonHomePage() => PeonHomePage(
  workspace: const Workspace(id: 'rnm', name: 'RNM'),
  peon: const Peon(
    id: 'marat',
    name: 'Marat',
    online: true,
    lastSeen: 100,
    capabilities: <String>[],
  ),
  onNewSession: _openPeonNewSession,
  sessionListBuilder: _buildPeonSessionList,
);

void _expectSelectedPeonTabUsesTheme(
  WidgetTester tester,
  String label,
  ThemeData theme,
) {
  final surface = tester.widget<Container>(
    find.byKey(Key('peon-tab-${label.toLowerCase()}-surface')),
  );
  final decoration = surface.decoration! as BoxDecoration;
  expect(decoration.color, theme.colorScheme.primaryContainer);
  final icon = tester.widget<Icon>(
    find.descendant(
      of: find.byKey(Key('peon-tab-${label.toLowerCase()}-surface')),
      matching: find.byType(Icon),
    ),
  );
  expect(icon.color, theme.colorScheme.primary);
}

void _openPeonNewSession(
  BuildContext context, {
  required String workspaceId,
  required String peonId,
  String? projectKey,
}) {
  Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => SessionDetailPage.newSession(
        workspaceId: workspaceId,
        peonId: peonId,
        projectKey: projectKey,
      ),
    ),
  );
}

Widget _buildPeonSessionList(
  BuildContext context, {
  required String workspaceId,
  required String peonId,
}) {
  return SessionSliverList(
    workspaceId: workspaceId,
    peonId: peonId,
    onSessionSelected: (session) => Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => SessionDetailPage(session: session),
      ),
    ),
  );
}

void main() {
  testWidgets('selected Peon tab follows a light theme', (tester) async {
    final theme = AppTheme.fromPackage(AppThemePackages.bundled[1]);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(
            _PendingSessionRepository(),
          ),
          projectRepositoryProvider.overrideWithValue(
            _PendingProjectRepository(),
          ),
        ],
        child: MaterialApp(theme: theme, home: _testPeonHomePage()),
      ),
    );
    await tester.pump();

    _expectSelectedPeonTabUsesTheme(tester, 'Work', theme);
    final statsIcon = tester.widget<Icon>(
      find.descendant(
        of: find.byKey(const Key('peon-tab-stats-surface')),
        matching: find.byType(Icon),
      ),
    );
    expect(statsIcon.color, theme.colorScheme.onSurfaceVariant);

    final package = AppThemePackages.bundled[1];
    final header = tester.widget<Container>(
      find.byKey(const Key('projects-section-header')),
    );
    final headerDecoration = header.decoration! as BoxDecoration;
    expect(
      headerDecoration.color,
      package.surfaceHover.withValues(alpha: 0.92),
    );
    expect(headerDecoration.border?.bottom.color, package.edge);
    expect(
      tester.widget<Text>(find.text('PROJECTS')).style?.color,
      package.inkMuted,
    );
  });

  testWidgets('shows shimmer skeletons while projects and sessions load', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(
            _PendingSessionRepository(),
          ),
          projectRepositoryProvider.overrideWithValue(
            _PendingProjectRepository(),
          ),
        ],
        child: MaterialApp(theme: AppTheme.dark, home: _testPeonHomePage()),
      ),
    );
    await tester.pump();

    expect(find.byKey(const Key('projects-loading-shimmer')), findsOneWidget);
    expect(find.byKey(const Key('sessions-loading-shimmer')), findsOneWidget);
    expect(find.bySemanticsLabel('Loading projects'), findsOneWidget);
    expect(find.bySemanticsLabel('Loading sessions'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.text('Loading projects…'), findsNothing);
    expect(find.text('Loading sessions'), findsNothing);
  });

  testWidgets('shows peon identity, navigation, and empty home sections', (
    tester,
  ) async {
    final repository = _FakeSessionRepository();
    final projectRepository = _FakeProjectRepository();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(repository),
          projectRepositoryProvider.overrideWithValue(projectRepository),
        ],
        child: MaterialApp(theme: AppTheme.dark, home: _testPeonHomePage()),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('peon-home-page')), findsOneWidget);
    final navigationBar = tester.widget<AppNavigationBar>(
      find.byKey(const Key('peon-navbar')),
    );
    expect(navigationBar.showBackButton, isTrue);
    expect(navigationBar.topInsetReduction, 0);
    expect(
      navigationBar.contentPadding,
      const EdgeInsets.fromLTRB(8, 10, 12, 6),
    );
    expect(
      find.ancestor(
        of: find.byKey(const Key('peon-navbar')),
        matching: find.byType(CustomScrollView),
      ),
      findsNothing,
    );
    expect(
      find.ancestor(
        of: find.byKey(const Key('peon-screen-padding')),
        matching: find.byType(CustomScrollView),
      ),
      findsOneWidget,
    );
    expect(tester.getSize(find.byKey(const Key('peon-navbar'))).height, 56);
    expect(
      tester.getSize(find.byKey(const Key('peon-tab-work'))),
      const Size(40, 40),
    );
    expect(
      tester.getSize(find.byKey(const Key('peon-tab-work-surface'))),
      const Size.square(36),
    );
    expect(
      tester.getCenter(find.byKey(const Key('peon-tab-stats'))).dx -
          tester.getCenter(find.byKey(const Key('peon-tab-work'))).dx,
      40,
    );
    expect(
      tester.getCenter(find.byKey(const Key('peon-tab-settings'))).dx -
          tester.getCenter(find.byKey(const Key('peon-tab-stats'))).dx,
      40,
    );
    expect(find.text('Marat'), findsOneWidget);
    expect(find.text('PROJECTS'), findsOneWidget);
    expect(find.text('SESSIONS'), findsOneWidget);
    expect(
      tester.getSize(find.byKey(const Key('projects-section-header'))).height,
      28,
    );
    expect(
      tester.getSize(find.byKey(const Key('sessions-section-header'))).height,
      28,
    );
    expect(
      tester.getTopLeft(find.byKey(const Key('projects-section-header'))).dy,
      tester.getBottomLeft(find.byKey(const Key('peon-navbar'))).dy,
    );
    expect(
      tester
          .widget<Padding>(
            find.byKey(const Key('projects-section-header-padding')),
          )
          .padding,
      const EdgeInsets.symmetric(horizontal: 12),
    );
    expect(
      tester
          .widget<Padding>(
            find.byKey(const Key('sessions-section-header-padding')),
          )
          .padding,
      const EdgeInsets.symmetric(horizontal: 12),
    );
    expect(find.text('+ NEW PROJECT'), findsOneWidget);
    expect(find.text('+ NEW SESSION'), findsOneWidget);
    for (final (headerKey, actionKey) in [
      (
        const Key('projects-section-header'),
        const Key('projects-toggle-action'),
      ),
      (const Key('projects-section-header'), const Key('new-project-action')),
      (const Key('sessions-section-header'), const Key('new-session-action')),
    ]) {
      expect(
        tester.getRect(find.byKey(actionKey)).height,
        tester.getRect(find.byKey(headerKey)).height,
      );
    }
    final viewportWidth = tester.getSize(find.byType(CustomScrollView)).width;
    for (final section in ['projects', 'sessions']) {
      final headerFinder = find.byKey(Key('$section-section-header'));
      final header = tester.widget<Container>(headerFinder);
      expect(
        (header.decoration! as BoxDecoration).color,
        AppColors.bone.withValues(alpha: 0.05),
      );
      expect(tester.getSize(headerFinder).width, viewportWidth);
    }
    final pinnedHeaders = tester.widgetList<SliverPersistentHeader>(
      find.byType(SliverPersistentHeader),
    );
    expect(pinnedHeaders, hasLength(2));
    expect(pinnedHeaders.every((header) => header.pinned), isTrue);
    expect(
      find.byKey(const Key('pinned-section-header-blur')),
      findsNWidgets(2),
    );
    expect(find.byType(BackdropFilter), findsNWidgets(2));
    expect(find.text('No projects on this peon yet.'), findsOneWidget);
    expect(find.text('No sessions yet', skipOffstage: false), findsOneWidget);
    expect(
      tester
          .widget<Padding>(find.byKey(const Key('peon-screen-padding')))
          .padding,
      const EdgeInsets.only(bottom: 32),
    );

    await tester.tap(find.text('PROJECTS'));
    await tester.pumpAndSettle();
    expect(find.text('No projects on this peon yet.'), findsNothing);
  });

  testWidgets('keeps the sessions section header pinned while scrolling', (
    tester,
  ) async {
    final repository = _FakeSessionRepository([
      for (var index = 0; index < 20; index++)
        _session('session-$index', activity: (100 - index).toDouble()),
    ]);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(repository),
          projectRepositoryProvider.overrideWithValue(_FakeProjectRepository()),
        ],
        child: MaterialApp(theme: AppTheme.dark, home: _testPeonHomePage()),
      ),
    );
    await tester.pumpAndSettle();

    final scrollView = find.byType(CustomScrollView);
    await tester.drag(scrollView, const Offset(0, -180));
    await tester.pumpAndSettle();
    final pinnedTop = tester
        .getTopLeft(find.byKey(const Key('sessions-section-header')))
        .dy;
    expect(pinnedTop, 56);

    await tester.drag(scrollView, const Offset(0, -120));
    await tester.pumpAndSettle();
    expect(
      tester.getTopLeft(find.byKey(const Key('sessions-section-header'))).dy,
      pinnedTop,
    );
  });

  testWidgets('lets the session viewport extend through the bottom safe area', (
    tester,
  ) async {
    final repository = _FakeSessionRepository([
      _session('safe-area-session', activity: 20),
    ]);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(repository),
          projectRepositoryProvider.overrideWithValue(_FakeProjectRepository()),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: MediaQuery(
            data: const MediaQueryData(
              size: Size(390, 844),
              padding: EdgeInsets.only(bottom: 34),
              viewPadding: EdgeInsets.only(bottom: 34),
            ),
            child: _testPeonHomePage(),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final safeArea = tester.widget<SafeArea>(
      find.ancestor(
        of: find.byType(CustomScrollView),
        matching: find.byType(SafeArea),
      ),
    );
    expect(safeArea.bottom, isFalse);
    expect(
      tester
          .widget<Padding>(find.byKey(const Key('peon-screen-padding')))
          .padding,
      const EdgeInsets.only(bottom: 66),
    );
    expect(
      tester.getBottomLeft(find.byType(CustomScrollView)).dy,
      tester.getBottomLeft(find.byKey(const Key('peon-home-page'))).dy,
    );
  });

  testWidgets('lazily builds only viewport-adjacent session rows', (
    tester,
  ) async {
    final repository = _FakeSessionRepository([
      for (var index = 0; index < 200; index++)
        _session('lazy-$index', activity: (1000 - index).toDouble()),
    ]);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(repository),
          projectRepositoryProvider.overrideWithValue(_FakeProjectRepository()),
        ],
        child: MaterialApp(theme: AppTheme.dark, home: _testPeonHomePage()),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('session-lazy-0')), findsOneWidget);
    expect(
      find.byKey(const Key('session-lazy-19'), skipOffstage: false),
      findsNothing,
    );
    expect(find.byType(SliverFixedExtentList), findsOneWidget);
    expect(find.byKey(const Key('sessions-load-more')), findsNothing);
    _expectStatusLight(
      tester,
      sessionId: 'lazy-0',
      color: SidebarStatusEdgeStyle.idle.color,
      glowing: false,
    );

    await tester.scrollUntilVisible(
      find.byKey(const Key('session-lazy-19'), skipOffstage: false),
      500,
      scrollable: find.byType(Scrollable).last,
    );
    await tester.pumpAndSettle();

    final sessions =
        ProviderScope.containerOf(
          tester.element(find.byType(PeonHomePage)),
        ).read(
          sessionsControllerProvider(
            const SessionsScope(workspaceId: 'rnm', peonId: 'marat'),
          ),
        );
    expect(sessions.requireValue.visibleCount, greaterThan(20));
    expect(sessions.requireValue.visibleCount % 20, 0);
    _expectStatusLight(
      tester,
      sessionId: 'lazy-19',
      color: SidebarStatusEdgeStyle.idle.color,
      glowing: false,
    );
  });

  testWidgets('opens the selected session detail page', (tester) async {
    final repository = _FakeSessionRepository([
      _session('selected-session', activity: 20, projectKey: 'overseer-mobile'),
    ]);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(repository),
          projectRepositoryProvider.overrideWithValue(_FakeProjectRepository()),
        ],
        child: MaterialApp(theme: AppTheme.dark, home: _testPeonHomePage()),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('session-selected-session')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.byType(SessionDetailPage), findsOneWidget);
    final title = tester.widget<Text>(find.byKey(const Key('session-title')));
    expect(title.textSpan?.toPlainText(), 'Overseer Mobile  selected-session');
  });

  testWidgets('opens the shared session page in its new-session state', (
    tester,
  ) async {
    final projectRepository = _FakeProjectRepository([
      const PeonProject(
        workspaceId: 'rnm',
        peonId: 'marat',
        projectId: 'overseer-mobile-id',
        key: 'overseer-mobile',
        name: 'Overseer Mobile',
        syncedAt: 1,
      ),
    ]);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(_FakeSessionRepository()),
          projectRepositoryProvider.overrideWithValue(projectRepository),
        ],
        child: MaterialApp(theme: AppTheme.dark, home: _testPeonHomePage()),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));

    await tester.tap(find.text('+ NEW SESSION'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.byKey(const Key('session-detail-page')), findsOneWidget);
    expect(
      find.byKey(const Key('new-session-project-selection')),
      findsOneWidget,
    );
    expect(find.text('New session'), findsOneWidget);
    expect(find.text('Select a project'), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(const Key('new-session-project-overseer-mobile-id')),
        matching: find.text('Overseer Mobile'),
      ),
      findsOneWidget,
    );
    expect(find.byKey(const Key('session-files')), findsNothing);

    await tester.tap(
      find.byKey(const Key('new-session-project-overseer-mobile-id')),
    );
    await tester.pump();
    expect(
      tester
          .widget<Text>(find.byKey(const Key('session-title')))
          .textSpan
          ?.toPlainText(),
      'Overseer Mobile  New session',
    );
  });

  testWidgets('activity update animates reordered visible sessions', (
    tester,
  ) async {
    final repository = _FakeSessionRepository([
      _session('newer', activity: 20),
      _session('older', activity: 10, status: 'completed'),
    ]);
    final projectRepository = _FakeProjectRepository();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(repository),
          projectRepositoryProvider.overrideWithValue(projectRepository),
        ],
        child: MaterialApp(theme: AppTheme.dark, home: _testPeonHomePage()),
      ),
    );
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.byKey(const Key('session-newer'), skipOffstage: false),
      200,
    );

    expect(
      tester.getTopLeft(find.byKey(const Key('session-newer'))).dy,
      lessThan(tester.getTopLeft(find.byKey(const Key('session-older'))).dy),
    );
    expect(find.text('RUNNING'), findsNothing);
    expect(find.text('COMPLETED'), findsNothing);
    _expectStatusLight(
      tester,
      sessionId: 'newer',
      color: SidebarStatusEdgeStyle.idle.color,
      glowing: false,
    );
    _expectStatusLight(
      tester,
      sessionId: 'older',
      color: SidebarStatusEdgeStyle.idle.color,
      glowing: false,
    );
    _expectSessionInteractionColors(tester, sessionId: 'newer');

    repository.emit([
      _session('older', activity: 30),
      _session('newer', activity: 20, status: 'completed'),
    ]);
    await tester.pump();
    await tester.pump();

    final initialOlderTop = tester
        .getTopLeft(find.byKey(const Key('session-older')))
        .dy;
    final initialNewerTop = tester
        .getTopLeft(find.byKey(const Key('session-newer')))
        .dy;
    expect(initialNewerTop, lessThan(initialOlderTop));

    await tester.pump(const Duration(milliseconds: 120));

    final movingOlderTop = tester
        .getTopLeft(find.byKey(const Key('session-older')))
        .dy;
    final movingNewerTop = tester
        .getTopLeft(find.byKey(const Key('session-newer')))
        .dy;
    expect(movingOlderTop, lessThan(initialOlderTop));
    expect(movingNewerTop, greaterThan(initialNewerTop));
    final flightTransform = tester.widget<Transform>(
      find.byKey(const Key('session-flight-position-older')),
    );
    expect(flightTransform.transform.getTranslation().x, 0);
    expect(flightTransform.transform.getTranslation().y, greaterThan(0));
    expect(
      _statusEdgeDecoration(
        tester,
        const Key('session-status-older'),
      ).boxShadow,
      hasLength(3),
    );
    expect(
      _statusEdgeDecoration(
        tester,
        const Key('session-status-newer'),
      ).boxShadow,
      hasLength(3),
    );
    final idleFlare = _statusEdgeDecoration(
      tester,
      const Key('session-status-newer'),
    ).boxShadow!.first;
    expect(idleFlare.color.withValues(alpha: 1), AppColors.fel);

    await tester.pump(const Duration(milliseconds: 120));

    await tester.pumpAndSettle();

    expect(
      tester.getTopLeft(find.byKey(const Key('session-older'))).dy,
      lessThan(tester.getTopLeft(find.byKey(const Key('session-newer'))).dy),
    );
    _expectStatusLight(
      tester,
      sessionId: 'older',
      color: SidebarStatusEdgeStyle.idle.color,
      glowing: false,
    );
  });

  testWidgets('periodic reconciliation recovers a missed activity update', (
    tester,
  ) async {
    final repository = _FakeSessionRepository([
      _session('newer', activity: 20),
      _session('older', activity: 10),
    ]);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(repository),
          projectRepositoryProvider.overrideWithValue(_FakeProjectRepository()),
        ],
        child: MaterialApp(theme: AppTheme.dark, home: _testPeonHomePage()),
      ),
    );
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.byKey(const Key('session-newer'), skipOffstage: false),
      200,
    );
    final initialFetchCount = repository.fetchCount;

    repository.replaceRemote([
      _session('older', activity: 30),
      _session('newer', activity: 20),
    ]);
    await tester.pump(const Duration(seconds: 5));
    await tester.pump();
    await tester.pumpAndSettle();

    expect(repository.fetchCount, greaterThan(initialFetchCount));
    expect(
      tester.getTopLeft(find.byKey(const Key('session-older'))).dy,
      lessThan(tester.getTopLeft(find.byKey(const Key('session-newer'))).dy),
    );
  });

  testWidgets('shows session rollups together and the active light', (
    tester,
  ) async {
    final projectRepository = _FakeProjectRepository([
      const PeonProject(
        workspaceId: 'rnm',
        peonId: 'marat',
        projectId: 'overseer-mobile',
        key: 'overseer-mobile',
        name: 'Overseer Mobile',
        memberCount: 2,
        sessionCount: 20,
        activeCount: 0,
        syncedAt: 100,
      ),
    ]);
    final sessionRepository = _FakeSessionRepository([
      _session(
        'active-project-session',
        activity: 100,
        projectKey: 'overseer-mobile',
      ),
    ]);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(sessionRepository),
          projectRepositoryProvider.overrideWithValue(projectRepository),
        ],
        child: MaterialApp(theme: AppTheme.dark, home: _testPeonHomePage()),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Overseer Mobile'), findsOneWidget);
    expect(find.text('2 members'), findsNothing);
    expect(find.text('•'), findsOneWidget);
    expect(find.text('20 sessions'), findsOneWidget);
    expect(find.text('1 active'), findsOneWidget);
    expect(
      tester
          .getTopLeft(
            find.byKey(const Key('project-active-count-overseer-mobile')),
          )
          .dx,
      lessThan(
        tester
            .getTopLeft(
              find.byKey(const Key('project-activity-overseer-mobile')),
            )
            .dx,
      ),
    );
    final projectActivity = tester.widget<Text>(
      find.byKey(const Key('project-activity-overseer-mobile')),
    );
    final sessionActivity = tester.widget<Text>(
      find.byKey(const Key('session-activity-active-project-session')),
    );
    expect(projectActivity.style?.fontFamily, AppTypography.fontFamily);
    expect(sessionActivity.style?.fontFamily, AppTypography.fontFamily);
    final sessionProjectKey = tester.widget<Text>(
      find.descendant(
        of: find.byKey(const Key('session-active-project-session')),
        matching: find.text('overseer-mobile'),
      ),
    );
    expect(sessionProjectKey.style?.fontFamily, AppTypography.fontFamily);
    final decoration = _statusEdgeDecoration(
      tester,
      const Key('project-status-overseer-mobile'),
    );
    expect(decoration.color, AppColors.felBright);
    expect(decoration.boxShadow, isNotEmpty);
    final projectInkWell = tester.widget<InkWell>(
      find.descendant(
        of: find.byKey(const Key('project-overseer-mobile')),
        matching: find.byType(InkWell),
      ),
    );
    expect(projectInkWell.overlayColor, isNull);
    expect(
      tester
          .getTopLeft(find.byKey(const Key('project-status-overseer-mobile')))
          .dx,
      tester
          .getTopLeft(
            find.byKey(const Key('session-status-active-project-session')),
          )
          .dx,
    );

    sessionRepository.emit([
      _session(
        'active-project-session',
        activity: 110,
        status: 'completed',
        projectKey: 'overseer-mobile',
      ),
    ]);
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(
      _statusEdgeDecoration(
        tester,
        const Key('project-status-overseer-mobile'),
      ).boxShadow,
      hasLength(3),
    );
    await tester.pumpAndSettle();

    expect(find.text('1 active'), findsNothing);
    final inactiveDecoration = _statusEdgeDecoration(
      tester,
      const Key('project-status-overseer-mobile'),
    );
    expect(inactiveDecoration.color, SidebarStatusEdgeStyle.idle.color);
    expect(inactiveDecoration.boxShadow, isNull);
  });

  testWidgets(
    'cached running session stays inactive without an authoritative snapshot',
    (tester) async {
      final projectRepository = _FakeProjectRepository([
        const PeonProject(
          workspaceId: 'rnm',
          peonId: 'marat',
          projectId: 'overseer-ios',
          key: 'overseer-ios',
          name: 'Overseer iOS',
          sessionCount: 12,
          syncedAt: 100,
        ),
      ]);
      final sessionRepository = _FakeSessionRepository([
        _session('stale-running', activity: 100, projectKey: 'overseer-ios'),
      ]);
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sessionRepositoryProvider.overrideWithValue(sessionRepository),
            projectRepositoryProvider.overrideWithValue(projectRepository),
          ],
          child: MaterialApp(theme: AppTheme.dark, home: _testPeonHomePage()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('1 active'), findsOneWidget);
      final sessionStatusContainer = find.descendant(
        of: find.byKey(const Key('session-status-stale-running')),
        matching: find.byType(Container),
      );
      var sessionDecoration =
          tester.widget<Container>(sessionStatusContainer).decoration!
              as BoxDecoration;
      expect(sessionDecoration.color, SidebarStatusEdgeStyle.idle.color);
      expect(sessionDecoration.boxShadow, isNull);

      final container = ProviderScope.containerOf(
        tester.element(find.byType(PeonHomePage)),
      );
      container
          .read(activeSessionsProvider.notifier)
          .replaceWorkspace('rnm', const []);
      await tester.pumpAndSettle();

      expect(find.text('1 active'), findsNothing);
      final projectDecoration = _statusEdgeDecoration(
        tester,
        const Key('project-status-overseer-ios'),
      );
      expect(projectDecoration.color, SidebarStatusEdgeStyle.idle.color);
      expect(projectDecoration.boxShadow, isNull);
      sessionDecoration =
          tester.widget<Container>(sessionStatusContainer).decoration!
              as BoxDecoration;
      expect(sessionDecoration.color, SidebarStatusEdgeStyle.idle.color);
      expect(sessionDecoration.boxShadow, isNull);
    },
  );

  testWidgets('ignores a stale project active count when sessions are loaded', (
    tester,
  ) async {
    final projectRepository = _FakeProjectRepository([
      const PeonProject(
        workspaceId: 'rnm',
        peonId: 'marat',
        projectId: 'overseer-mobile',
        key: 'overseer-mobile',
        name: 'Overseer Mobile',
        memberCount: 2,
        sessionCount: 20,
        activeCount: 3,
        syncedAt: 100,
      ),
    ]);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(_FakeSessionRepository()),
          projectRepositoryProvider.overrideWithValue(projectRepository),
        ],
        child: MaterialApp(theme: AppTheme.dark, home: _testPeonHomePage()),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('3 active'), findsNothing);
    final decoration = _statusEdgeDecoration(
      tester,
      const Key('project-status-overseer-mobile'),
    );
    expect(decoration.color, SidebarStatusEdgeStyle.idle.color);
    expect(decoration.boxShadow, isNull);
  });

  testWidgets('does not use a project active count while sessions load', (
    tester,
  ) async {
    final projectRepository = _FakeProjectRepository([
      const PeonProject(
        workspaceId: 'rnm',
        peonId: 'marat',
        projectId: 'overseer-mobile',
        key: 'overseer-mobile',
        name: 'Overseer Mobile',
        activeCount: 3,
        syncedAt: 100,
      ),
    ]);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(
            _PendingSessionRepository(),
          ),
          projectRepositoryProvider.overrideWithValue(projectRepository),
        ],
        child: MaterialApp(theme: AppTheme.dark, home: _testPeonHomePage()),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(find.text('3 active'), findsNothing);
    final decoration = _statusEdgeDecoration(
      tester,
      const Key('project-status-overseer-mobile'),
    );
    expect(decoration.color, SidebarStatusEdgeStyle.idle.color);
    expect(decoration.boxShadow, isNull);
  });

  testWidgets('long press opens a session action sheet on compact layouts', (
    tester,
  ) async {
    await _loadGoldenFonts();
    tester.view.physicalSize = const Size(1080, 2340);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final repository = _FakeSessionRepository([_session('menu', activity: 20)]);
    final projectRepository = _FakeProjectRepository([
      const PeonProject(
        workspaceId: 'rnm',
        peonId: 'marat',
        projectId: 'overseer-mobile',
        key: 'overseer-mobile',
        name: 'Overseer Mobile',
        memberCount: 1,
        sessionCount: 1,
        activeCount: 0,
        syncedAt: 20,
      ),
    ]);
    MethodCall? hapticCall;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'HapticFeedback.vibrate') hapticCall = call;
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(repository),
          projectRepositoryProvider.overrideWithValue(projectRepository),
        ],
        child: MaterialApp(theme: AppTheme.dark, home: _testPeonHomePage()),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('PROJECTS'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.byKey(const Key('session-menu'), skipOffstage: false),
      200,
    );

    await tester.longPress(find.byKey(const Key('session-menu')));
    await tester.pumpAndSettle();

    expect(hapticCall?.arguments, 'HapticFeedbackType.mediumImpact');
    expect(find.byKey(const Key('session-menu-rename')), findsOneWidget);
    expect(find.byKey(const Key('session-menu-delete')), findsOneWidget);
    expect(find.text('Rename'), findsOneWidget);
    expect(find.text('Delete'), findsOneWidget);
    expect(find.text('Session actions'), findsOneWidget);
    expect(find.byType(BottomSheet), findsOneWidget);
    expect(find.byType(AppOptionBottomSheet), findsOneWidget);
    expect(find.byType(AppOptionSheetTile), findsNWidgets(2));
    expect(find.byKey(const Key('session-menu-sheet-handle')), findsOneWidget);
    await expectLater(
      find.byType(Overlay).first,
      matchesGoldenFile('goldens/session_context_bottom_sheet.png'),
    );

    await tester.tap(find.byKey(const Key('session-menu-rename')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('session-menu-rename')), findsNothing);
    expect(find.text('Rename session'), findsOneWidget);
    final renameField = find.descendant(
      of: find.byKey(const Key('session-rename-field')),
      matching: find.byType(EditableText),
    );
    await tester.enterText(renameField, 'Release readiness');
    await tester.tap(find.byKey(const Key('session-rename-save')));
    await tester.pumpAndSettle();

    expect(find.text('Rename session'), findsNothing);
    expect(repository.renamedSession, (
      workspaceId: 'rnm',
      peonId: 'marat',
      sessionId: 'menu',
      title: 'Release readiness',
    ));

    await tester.longPress(find.byKey(const Key('session-menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('session-menu-delete')));
    await tester.pumpAndSettle();

    expect(find.text('Delete session?'), findsOneWidget);
    expect(find.textContaining('This cannot be undone.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('confirmation-confirm')));
    await tester.pumpAndSettle();
    expect(repository.deletedSession, (
      workspaceId: 'rnm',
      peonId: 'marat',
      sessionId: 'menu',
    ));
  });

  testWidgets('long press keeps the context menu on wide layouts', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final repository = _FakeSessionRepository([
      _session('wide-menu', activity: 20),
    ]);
    final projectRepository = _FakeProjectRepository([
      const PeonProject(
        workspaceId: 'rnm',
        peonId: 'marat',
        projectId: 'overseer-mobile',
        key: 'overseer-mobile',
        name: 'Overseer Mobile',
        memberCount: 1,
        sessionCount: 1,
        activeCount: 0,
        syncedAt: 20,
      ),
    ]);
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (_) async => null,
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(repository),
          projectRepositoryProvider.overrideWithValue(projectRepository),
        ],
        child: MaterialApp(theme: AppTheme.dark, home: _testPeonHomePage()),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('PROJECTS'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.byKey(const Key('session-wide-menu'), skipOffstage: false),
      200,
    );

    await tester.longPress(find.byKey(const Key('session-wide-menu')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('session-menu-rename')), findsOneWidget);
    expect(find.byKey(const Key('session-menu-delete')), findsOneWidget);
    expect(find.byType(BottomSheet), findsNothing);
  });
}

Future<void> _loadGoldenFonts() async {
  final golos = FontLoader('Golos Text')
    ..addFont(rootBundle.load('assets/fonts/golos_text/GolosText-Regular.ttf'))
    ..addFont(rootBundle.load('assets/fonts/golos_text/GolosText-Medium.ttf'))
    ..addFont(rootBundle.load('assets/fonts/golos_text/GolosText-Bold.ttf'));
  final lucide = FontLoader('packages/lucide_icons_flutter/Lucide')
    ..addFont(
      rootBundle.load('packages/lucide_icons_flutter/assets/lucide.ttf'),
    );
  await Future.wait([golos.load(), lucide.load()]);
}

void _expectSessionInteractionColors(
  WidgetTester tester, {
  required String sessionId,
}) {
  final inkWell = tester.widget<InkWell>(
    find.descendant(
      of: find.byKey(Key('session-$sessionId')),
      matching: find.byType(InkWell),
    ),
  );
  expect(inkWell.overlayColor, isNull);
  final theme = Theme.of(tester.element(find.byKey(Key('session-$sessionId'))));
  expect(theme.hoverColor, AppColors.fel.withValues(alpha: 0.10));
  expect(theme.highlightColor, AppColors.fel.withValues(alpha: 0.14));
}

void _expectStatusLight(
  WidgetTester tester, {
  required String sessionId,
  required Color color,
  required bool glowing,
}) {
  final light = tester.widget<Container>(
    find
        .descendant(
          of: find.byKey(Key('session-status-$sessionId')),
          matching: find.byType(Container),
        )
        .first,
  );
  final decoration = light.decoration! as BoxDecoration;
  expect(decoration.color, color);
  expect(decoration.boxShadow?.isNotEmpty ?? false, glowing);
}

BoxDecoration _statusEdgeDecoration(WidgetTester tester, Key key) {
  final container = find
      .descendant(of: find.byKey(key), matching: find.byType(Container))
      .first;
  return tester.widget<Container>(container).decoration! as BoxDecoration;
}

SessionSummary _session(
  String id, {
  required double activity,
  String status = 'running',
  String? projectKey,
}) {
  return SessionSummary(
    workspaceId: 'rnm',
    peonId: 'marat',
    sessionId: id,
    title: id,
    status: status,
    projectKey: projectKey,
    lastActivityAt: activity,
    syncedAt: activity,
  );
}

class _FakeSessionRepository implements SessionRepository {
  _FakeSessionRepository([this._sessions = const []]);

  final StreamController<List<SessionSummary>> _controller =
      StreamController<List<SessionSummary>>.broadcast();
  List<SessionSummary> _sessions;
  int fetchCount = 0;
  ({String workspaceId, String peonId, String sessionId, String? title})?
  renamedSession;
  ({String workspaceId, String peonId, String sessionId})? deletedSession;

  void emit(List<SessionSummary> sessions) {
    _sessions = sessions;
    _controller.add(sessions);
  }

  void replaceRemote(List<SessionSummary> sessions) {
    _sessions = sessions;
  }

  @override
  Future<List<SessionSummary>> loadCachedSessions({
    required String workspaceId,
    required String peonId,
  }) async => _sessions;

  @override
  Stream<List<SessionSummary>> watchSessions({
    required String workspaceId,
    required String peonId,
  }) async* {
    yield _sessions;
    yield* _controller.stream;
  }

  @override
  Future<SessionPage> fetchPage({
    required String workspaceId,
    required String peonId,
    required int offset,
    int limit = 50,
  }) async {
    fetchCount += 1;
    _controller.add(_sessions);
    return SessionPage(
      sessions: _sessions,
      total: _sessions.length,
      offset: offset,
      limit: limit,
      catalogStale: false,
    );
  }

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
  }) async {
    renamedSession = (
      workspaceId: workspaceId,
      peonId: peonId,
      sessionId: sessionId,
      title: title,
    );
  }

  @override
  Future<void> deleteSession({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) async {
    deletedSession = (
      workspaceId: workspaceId,
      peonId: peonId,
      sessionId: sessionId,
    );
  }

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

  @override
  Future<int> cursorFor(String workspaceId) async => 0;
}

class _PendingSessionRepository extends _FakeSessionRepository {
  final Completer<List<SessionSummary>> _cachedSessions = Completer();

  @override
  Future<List<SessionSummary>> loadCachedSessions({
    required String workspaceId,
    required String peonId,
  }) => _cachedSessions.future;
}

class _PendingProjectRepository extends _FakeProjectRepository {
  final Completer<List<PeonProject>> _cachedProjects = Completer();

  @override
  Future<List<PeonProject>> loadCachedProjects({
    required String workspaceId,
    required String peonId,
  }) => _cachedProjects.future;
}

class _FakeProjectRepository implements ProjectRepository {
  _FakeProjectRepository([this._projects = const []]);

  final StreamController<List<PeonProject>> _controller =
      StreamController<List<PeonProject>>.broadcast();
  final List<PeonProject> _projects;

  @override
  Future<List<PeonProject>> loadCachedProjects({
    required String workspaceId,
    required String peonId,
  }) async => _projects;

  @override
  Stream<List<PeonProject>> watchProjects({
    required String workspaceId,
    required String peonId,
  }) async* {
    yield _projects;
    yield* _controller.stream;
  }

  @override
  Future<ProjectSnapshot> refreshProjects({
    required String workspaceId,
    required String peonId,
  }) async {
    return ProjectSnapshot(
      projects: _projects,
      catalog: const ProjectCatalog(state: 'ready', stale: false),
    );
  }

  @override
  Future<ProjectSuggestion> suggestProject({
    required String workspaceId,
    required String peonId,
    required String label,
  }) async => const ProjectSuggestion();

  @override
  Future<void> createProject({
    required String workspaceId,
    required String peonId,
    required String label,
    String? dir,
    String? metadata,
  }) async {}

  @override
  Future<ProjectDirectory> fetchDirectory({
    required String workspaceId,
    required String peonId,
    required String projectKey,
    required String path,
  }) async => ProjectDirectory(path: path, entries: const []);

  @override
  Future<ProjectFilePreview> fetchFile({
    required String workspaceId,
    required String peonId,
    required String projectKey,
    required String path,
  }) => throw UnimplementedError();

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

  @override
  Future<int> cursorFor(String workspaceId) async => 0;
}
