import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';
import 'package:overseer_mobile/features/fleet/application/fleet_controller.dart';
import 'package:overseer_mobile/features/fleet/domain/fleet_models.dart';
import 'package:overseer_mobile/features/fleet/fleet.dart';
import 'package:overseer_mobile/features/projects/application/projects_controller.dart';
import 'package:overseer_mobile/features/projects/domain/project_models.dart';
import 'package:overseer_mobile/features/sessions/application/sessions_controller.dart';
import 'package:overseer_mobile/features/sessions/domain/session_models.dart';
import 'package:overseer_mobile/features/shell/shell.dart';
import 'package:overseer_mobile/shared/design/theme.dart';

void main() {
  testWidgets(
    'desktop sidebar groups chats, navigates, switches peons and resizes',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1440, 1000);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      final font = FontLoader('Golos Text')
        ..addFont(
          rootBundle.load('assets/fonts/golos_text/GolosText-Regular.ttf'),
        );
      await font.load();
      final icons = FontLoader('packages/lucide_icons_flutter/Lucide')
        ..addFont(
          rootBundle.load('packages/lucide_icons_flutter/assets/lucide.ttf'),
        );
      await icons.load();
      if (Platform.environment['CAPTURE_SIDEBAR_SCREENSHOT'] == '1') {
        final monoFile = File(
          Platform.isWindows
              ? '${Platform.environment['WINDIR'] ?? 'C:/Windows'}/Fonts/consola.ttf'
              : '/System/Library/Fonts/Menlo.ttc',
        );
        if (monoFile.existsSync()) {
          await (FontLoader('monospace')..addFont(
                Future.value(ByteData.sublistView(monoFile.readAsBytesSync())),
              ))
              .load();
        }
      }
      String? openedProject;
      String? openedSession;
      String? newChatProject;
      var newProject = false;
      var returnedToConnections = false;
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            fleetControllerProvider.overrideWith(_Fleet.new),
            selectedSidebarChatProvider.overrideWithValue((
              workspaceId: 'rnm',
              peonId: 'one',
              sessionId: 'chat',
            )),
            for (final peonId in ['one', 'two'])
              projectsControllerProvider(
                ProjectsScope(workspaceId: 'rnm', peonId: peonId),
              ).overrideWith(
                () => _Projects(
                  ProjectsScope(workspaceId: 'rnm', peonId: peonId),
                ),
              ),
            for (final peonId in ['one', 'two'])
              sessionsControllerProvider(
                SessionsScope(workspaceId: 'rnm', peonId: peonId),
              ).overrideWith(
                () => _Sessions(
                  SessionsScope(workspaceId: 'rnm', peonId: peonId),
                ),
              ),
            fleetOverviewMaxWidthProvider.overrideWithValue(double.infinity),
            fleetWorkspaceSpacingProvider.overrideWithValue(true),
            fleetSidebarBuilderProvider.overrideWithValue(
              (context) => DesktopFleetSidebar(
                onProject: (_, workspace, peon, project) =>
                    openedProject = '${peon.id}/${project.key}',
                onSession: (_, session) => openedSession = session.sessionId,
                onNewProject: (_, scope) => newProject = true,
                onNewSession: (_, scope, project) => newChatProject = project,
              ),
            ),
          ],
          child: MaterialApp(
            theme: AppTheme.dark,
            home: RepaintBoundary(
              key: const Key('capture'),
              child: ShellPage(
                user: const OperatorIdentity(email: 'operator@example.com'),
                onSignOut: () async {},
                overseerName: 'overseer.rnm.dev',
                onBackToConnections: () => returnedToConnections = true,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('fleet-overview')), findsOneWidget);
      expect(find.byKey(const Key('notification-setting')), findsNothing);
      expect(find.byKey(const Key('desktop-fleet-sidebar')), findsOneWidget);
      expect(
        tester.getBottomLeft(find.byKey(const Key('shell-account-footer'))).dy,
        1000,
      );
      expect(find.text('Alpha'), findsOneWidget);
      BoxDecoration chatDecoration() =>
          tester
                  .widget<Container>(
                    find.descendant(
                      of: find.byKey(const ValueKey('sidebar-chat-chat')),
                      matching: find.byType(Container),
                    ),
                  )
                  .decoration!
              as BoxDecoration;
      expect(
        chatDecoration().color,
        Color.alphaBlend(
          AppTheme.dark.colorScheme.primaryContainer.withAlpha(78),
          AppTheme.dark.colorScheme.surfaceContainerHighest,
        ).withValues(alpha: .5),
      );
      expect(
        tester
            .getBottomLeft(find.byKey(const ValueKey('sidebar-list-rnm-one')))
            .dy,
        tester.getTopLeft(find.byKey(const Key('shell-account-footer'))).dy,
      );
      expect(find.text('Deleted'), findsNothing);
      expect(find.byKey(const ValueKey('sidebar-chat-orphan')), findsOneWidget);
      await tester.tap(find.text('Alpha'));
      expect(openedProject, 'one/alpha');
      await tester.tap(find.byKey(const ValueKey('sidebar-chat-chat')));
      expect(openedSession, 'chat');
      await tester.tap(find.byTooltip('New chat in Alpha'));
      expect(newChatProject, 'alpha');
      await tester.tap(find.byTooltip('New project'));
      expect(newProject, isTrue);
      expect(
        find.byKey(const Key('sidebar-new-project-group')),
        findsOneWidget,
      );
      await tester.tap(find.byTooltip('Collapse Alpha'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('sidebar-chat-chat')), findsNothing);
      await tester.tap(find.byTooltip('Expand Alpha'));
      await tester.pumpAndSettle();

      if (Platform.environment['CAPTURE_SIDEBAR_SCREENSHOT'] == '1') {
        await tester.runAsync(() async {
          final boundary = tester.renderObject<RenderRepaintBoundary>(
            find.byKey(const Key('capture')),
          );
          final image = await boundary.toImage();
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          image.dispose();
          await File(
            '${Directory.current.path}/../../.local/desktop-build/fleet-sidebar.png',
          ).writeAsBytes(bytes!.buffer.asUint8List());
        });
      }
      await tester.tap(find.byTooltip('Chat list display'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Flat list'));
      await tester.pumpAndSettle();
      expect(find.text('Projects'), findsOneWidget);
      expect(find.byKey(const Key('sidebar-new-project-group')), findsNothing);
      newProject = false;
      await tester.tap(find.byTooltip('New project'));
      expect(newProject, isTrue);
      expect(find.text('Sessions'), findsOneWidget);
      await tester.tap(find.byKey(const Key('sidebar-peon-selector')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('RNM / Second').last);
      await tester.pumpAndSettle();
      expect(find.text('Beta'), findsOneWidget);
      expect(chatDecoration().color, isNull);
      expect(find.text('Alpha'), findsNothing);
      for (final width in [1000.0, 600.0]) {
        tester.view.physicalSize = Size(width, 1000);
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('desktop-fleet-sidebar')), findsOneWidget);
        expect(find.text('Beta'), findsOneWidget);
        expect(
          tester
              .getBottomLeft(find.byKey(const ValueKey('sidebar-list-rnm-two')))
              .dy,
          tester.getTopLeft(find.byKey(const Key('shell-account-footer'))).dy,
        );
        expect(tester.takeException(), isNull);
      }
      tester.view.physicalSize = const Size(500, 900);
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Projects and chats'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('desktop-fleet-sidebar')), findsOneWidget);
      expect(find.text('Beta'), findsOneWidget);
      expect(tester.takeException(), isNull);
      tester.view.physicalSize = const Size(500, 500);
      await tester.pumpAndSettle();
      final footer = find.byKey(const Key('shell-account-footer'));
      final footerBefore = tester.getRect(footer);
      expect(footerBefore.bottom, 500);
      final header = find.byKey(const Key('shell-overview-navigation'));
      final headerBefore = tester.getRect(header);
      final selector = find.byKey(const Key('sidebar-peon-selector'));
      final selectorBefore = tester.getRect(selector);
      final list = find.byKey(const ValueKey('sidebar-list-rnm-two'));
      final scrollable = tester.state<ScrollableState>(
        find.descendant(of: list, matching: find.byType(Scrollable)),
      );
      final offsetBefore = scrollable.position.pixels;
      await tester.drag(list, const Offset(0, -80));
      await tester.pumpAndSettle();
      expect(scrollable.position.pixels, greaterThan(offsetBefore));
      expect(tester.getRect(header), headerBefore);
      expect(tester.getRect(selector), selectorBefore);
      expect(tester.getRect(footer), footerBefore);
      expect(
        find.descendant(
          of: find.byType(Drawer),
          matching: find.byType(Scrollable),
        ),
        findsOneWidget,
      );
      expect(find.byKey(const Key('shell-back-to-connections')), findsNothing);
      expect(returnedToConnections, isFalse);
      expect(tester.takeException(), isNull);
    },
  );
}

class _Fleet extends FleetController {
  @override
  Future<List<WorkspaceFleet>> build() async => const [
    WorkspaceFleet(
      workspace: Workspace(id: 'rnm', name: 'RNM'),
      peons: [
        Peon(
          id: 'one',
          name: 'Cortana',
          online: true,
          lastSeen: 100,
          capabilities: [],
        ),
        Peon(
          id: 'two',
          name: 'Second',
          online: true,
          lastSeen: 100,
          capabilities: [],
        ),
      ],
    ),
  ];
}

class _Projects extends ProjectsController {
  _Projects(super.scope);
  @override
  Future<ProjectsState> build() async => ProjectsState(
    projects: [
      PeonProject(
        workspaceId: scope.workspaceId,
        peonId: scope.peonId,
        projectId: 'project',
        key: scope.peonId == 'one' ? 'alpha' : 'beta',
        name: scope.peonId == 'one' ? 'Alpha' : 'Beta',
        syncedAt: 100,
        sessionCount: 1,
      ),
      PeonProject(
        workspaceId: scope.workspaceId,
        peonId: scope.peonId,
        projectId: 'deleted',
        key: 'deleted',
        name: 'Deleted',
        syncedAt: 100,
        deleted: true,
      ),
    ],
  );
}

class _Sessions extends SessionsController {
  _Sessions(super.scope);
  @override
  Future<SessionsState> build() async => SessionsState(
    sessions: [
      SessionSummary(
        workspaceId: scope.workspaceId,
        peonId: scope.peonId,
        sessionId: 'chat',
        projectId: 'project',
        title: 'Review the latest desktop changes',
        preview: 'The release is ready for review.',
        syncedAt: 100,
        status: 'running',
      ),
      SessionSummary(
        workspaceId: scope.workspaceId,
        peonId: scope.peonId,
        sessionId: 'orphan',
        projectId: 'missing',
        title: 'Discuss next steps',
        syncedAt: 90,
        attentionUnread: true,
      ),
    ],
  );
}
