import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/fleet/application/fleet_controller.dart';
import 'package:overseer_mobile/features/fleet/domain/fleet_models.dart';
import 'package:overseer_mobile/features/fleet/domain/fleet_repository.dart';
import 'package:overseer_mobile/features/shell/presentation/shell_page.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';
import 'package:overseer_mobile/shared/layout/responsive_breakpoints.dart';
import 'package:overseer_mobile/shared/widgets/app_restoring_page.dart';

void main() {
  group('ResponsiveBreakpoints', () {
    test('classifies boundary widths', () {
      expect(ResponsiveBreakpoints.sizeFor(599), ResponsiveLayoutSize.compact);
      expect(ResponsiveBreakpoints.sizeFor(600), ResponsiveLayoutSize.medium);
      expect(ResponsiveBreakpoints.sizeFor(1023), ResponsiveLayoutSize.medium);
      expect(ResponsiveBreakpoints.sizeFor(1024), ResponsiveLayoutSize.wide);
    });
  });

  group('ShellPage', () {
    testWidgets('keeps the branded loader until initial fleet data arrives', (
      tester,
    ) async {
      final result = Completer<List<WorkspaceFleet>>();
      await _pumpShell(
        tester,
        width: 599,
        repository: _PendingFleetRepository(result.future),
        waitForFleet: false,
      );

      expect(find.byType(AppRestoringPage), findsOneWidget);
      expect(find.byKey(const Key('auth-restoring-progress')), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(find.byKey(const Key('compact-shell')), findsNothing);

      result.complete(const []);
      await tester.pump();

      expect(find.byType(AppRestoringPage), findsNothing);
      expect(find.byKey(const Key('compact-shell')), findsOneWidget);
    });

    testWidgets('uses the compact shell below 600 pixels', (tester) async {
      await _pumpShell(tester, width: 599);

      expect(find.byKey(const Key('compact-shell')), findsOneWidget);
      expect(find.byType(AppBar), findsNothing);
      await tester.pump();
      expect(find.byKey(const Key('fleet-overview')), findsOneWidget);
    });

    testWidgets('uses the medium shell from 600 pixels', (tester) async {
      await _pumpShell(tester, width: 600);

      expect(find.byKey(const Key('medium-shell')), findsOneWidget);
      expect(find.byKey(const Key('medium-navigation-rail')), findsOneWidget);
      await tester.pump();
      expect(find.byKey(const Key('fleet-overview')), findsOneWidget);
    });

    testWidgets('uses the wide shell from 1024 pixels', (tester) async {
      await _pumpShell(tester, width: 1024);

      expect(find.byKey(const Key('wide-shell')), findsOneWidget);
      expect(find.byKey(const Key('wide-sidebar')), findsOneWidget);
      expect(find.byKey(const Key('wide-master-pane')), findsOneWidget);
      expect(find.byKey(const Key('wide-detail-pane')), findsOneWidget);
    });

    testWidgets('switches shell when the viewport is resized', (tester) async {
      await _pumpShell(tester, width: 599);
      expect(find.byKey(const Key('compact-shell')), findsOneWidget);

      await tester.binding.setSurfaceSize(const Size(600, 800));
      await tester.pump();
      expect(find.byKey(const Key('medium-shell')), findsOneWidget);

      await tester.binding.setSurfaceSize(const Size(1024, 800));
      await tester.pump();
      expect(find.byKey(const Key('wide-shell')), findsOneWidget);
    });
  });
}

Future<void> _pumpShell(
  WidgetTester tester, {
  required double width,
  FleetRepository? repository,
  bool waitForFleet = true,
}) async {
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.binding.setSurfaceSize(Size(width, 800));
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        fleetRepositoryProvider.overrideWithValue(
          repository ?? _EmptyFleetRepository(),
        ),
      ],
      child: const MaterialApp(
        home: ShellPage(
          user: OperatorIdentity(email: 'dev@example.com'),
          onSignOut: _signOut,
        ),
      ),
    ),
  );
  if (waitForFleet) await tester.pump();
}

Future<void> _signOut() async {}

class _EmptyFleetRepository implements FleetRepository {
  @override
  Future<List<WorkspaceFleet>> loadFleet() async => const [];
}

class _PendingFleetRepository implements FleetRepository {
  const _PendingFleetRepository(this.result);

  final Future<List<WorkspaceFleet>> result;

  @override
  Future<List<WorkspaceFleet>> loadFleet() => result;
}
