import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';
import 'package:overseer_mobile/features/fleet/application/fleet_controller.dart';
import 'package:overseer_mobile/features/fleet/fleet.dart';
import 'package:overseer_mobile/features/fleet/domain/fleet_models.dart';
import 'package:overseer_mobile/features/fleet/domain/fleet_repository.dart';
import 'package:overseer_mobile/features/shell/presentation/shell_page.dart';
import 'package:overseer_mobile/shared/design/theme.dart';

void main() {
  testWidgets('captures the populated desktop fleet shell', (tester) async {
    final windowsLayout = Platform.environment['WINDOWS_FLEET_LAYOUT'] == '1';
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final fontLoader = FontLoader('Golos Text')
      ..addFont(
        rootBundle.load('assets/fonts/golos_text/GolosText-Regular.ttf'),
      )
      ..addFont(rootBundle.load('assets/fonts/golos_text/GolosText-Medium.ttf'))
      ..addFont(
        rootBundle.load('assets/fonts/golos_text/GolosText-SemiBold.ttf'),
      )
      ..addFont(rootBundle.load('assets/fonts/golos_text/GolosText-Bold.ttf'));
    await fontLoader.load();
    final icons = FontLoader('packages/lucide_icons_flutter/Lucide')
      ..addFont(
        rootBundle.load('packages/lucide_icons_flutter/assets/lucide.ttf'),
      );
    await icons.load();
    // Native macOS uses this system fallback; load it for optional captures too.
    if (Platform.environment['CAPTURE_SHELL_SCREENSHOT'] == '1') {
      final monoFile = File(
        Platform.isWindows
            ? '${Platform.environment['WINDIR'] ?? 'C:/Windows'}/Fonts/consola.ttf'
            : '/System/Library/Fonts/Menlo.ttc',
      );
      if (monoFile.existsSync()) {
        final mono = FontLoader('monospace')
          ..addFont(
            Future.value(ByteData.sublistView(monoFile.readAsBytesSync())),
          );
        await mono.load();
      }
    }
    await tester.binding.setSurfaceSize(const Size(1440, 900));
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          if (windowsLayout)
            fleetOverviewMaxWidthProvider.overrideWithValue(double.infinity),
          fleetRepositoryProvider.overrideWithValue(
            const _DesktopVisualFleetRepository(),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: RepaintBoundary(
            key: const Key('desktop-shell-capture'),
            child: ShellPage(
              user: const OperatorIdentity(email: 'operator@example.com'),
              onSignOut: _noopSignOut,
              overseerName: 'production.overseer',
              onBackToConnections: _noop,
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 700));

    expect(find.byKey(const Key('wide-shell')), findsOneWidget);
    expect(find.text('Atlas'), findsOneWidget);
    expect(find.text('Kanat'), findsOneWidget);
    expect(find.text('Ready response'), findsOneWidget);
    expect(
      tester.getSize(find.byKey(const Key('fleet-overview'))).width,
      windowsLayout ? 1440 - 233 : 760,
    );
    expect(
      tester.getSize(find.byKey(const Key('notification-setting'))).width,
      windowsLayout ? 1440 - 233 - 24 : 736,
    );
    if (Platform.environment['CAPTURE_SHELL_SCREENSHOT'] == '1') {
      await tester.runAsync(() async {
        final boundary = tester.renderObject<RenderRepaintBoundary>(
          find.byKey(const Key('desktop-shell-capture')),
        );
        final image = await boundary.toImage(pixelRatio: 1);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        image.dispose();
        if (bytes == null) {
          throw StateError('Could not encode shell screenshot');
        }
        final output = File(
          Platform.environment['SHELL_SCREENSHOT_PATH'] ??
              'test/features/shell/artifacts/desktop_shell_fleet.png',
        );
        await output.parent.create(recursive: true);
        await output.writeAsBytes(bytes.buffer.asUint8List());
      });
    }
    if (windowsLayout) {
      await tester.binding.setSurfaceSize(const Size(1000, 900));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 700));
      expect(find.byKey(const Key('medium-shell')), findsOneWidget);
      expect(
        tester.getSize(find.byKey(const Key('fleet-overview'))).width,
        1000 - 209,
      );
      expect(
        tester.getSize(find.byKey(const Key('notification-setting'))).width,
        1000 - 209 - 24,
      );
      expect(tester.takeException(), isNull);
    }
  });
}

void _noop() {}

Future<void> _noopSignOut() async {}

class _DesktopVisualFleetRepository implements FleetRepository {
  const _DesktopVisualFleetRepository();

  @override
  Future<List<WorkspaceFleet>> loadFleet() async => const [
    WorkspaceFleet(
      workspace: Workspace(id: 'atlas', name: 'Atlas'),
      peons: [
        Peon(
          id: 'kanat',
          name: 'Kanat',
          hostname: 'kanat-mac',
          online: true,
          lastSeen: 100,
          capabilities: ['codex'],
          load: PeonLoad(activeSessions: 2),
          recentSessions: [
            FleetRecentSession(
              workspaceId: 'atlas',
              peonId: 'kanat',
              sessionId: 'ready',
              title: 'Ready response',
              syncedAt: 100,
              attentionUpdatedAt: 100,
              attentionUnread: true,
              hasOutstandingRequest: false,
              lastActivityAt: 100,
            ),
            FleetRecentSession(
              workspaceId: 'atlas',
              peonId: 'kanat',
              sessionId: 'working',
              title: 'Release checklist',
              status: 'running',
              syncedAt: 90,
              attentionUpdatedAt: 90,
              attentionUnread: false,
              hasOutstandingRequest: true,
              lastActivityAt: 90,
            ),
          ],
        ),
        Peon(
          id: 'thor',
          name: 'Thor',
          online: false,
          lastSeen: 80,
          capabilities: [],
        ),
      ],
    ),
    WorkspaceFleet(
      workspace: Workspace(id: 'forge', name: 'Forge'),
      peons: [
        Peon(
          id: 'forge-runner',
          name: 'Forge runner',
          online: true,
          lastSeen: 80,
          capabilities: [],
        ),
      ],
    ),
  ];
}
