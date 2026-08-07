import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:overseer_mobile/features/themes/domain/app_theme_package.dart';
import 'package:overseer_mobile/shared/design/theme.dart';
import 'package:overseer_mobile/shared/widgets/adaptive_selection_picker.dart';
import 'package:overseer_mobile/shared/widgets/app_option_bottom_sheet.dart';

void main() {
  Future<void> pumpPicker(
    WidgetTester tester, {
    required double width,
    required ValueChanged<String> onSelected,
  }) async {
    tester.view.physicalSize = Size(width, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Center(
            child: AdaptiveSelectionPicker<String>(
              title: 'Sounds',
              value: 'Peon',
              options: const [
                SelectionOption(value: 'Peon', label: 'Peon'),
                SelectionOption(value: 'SCV', label: 'SCV'),
              ],
              onSelected: onSelected,
            ),
          ),
        ),
      ),
    );
  }

  testWidgets('uses an animated bottom sheet on compact layouts', (
    tester,
  ) async {
    String? selected;
    await pumpPicker(
      tester,
      width: 390,
      onSelected: (value) => selected = value,
    );

    await tester.tap(find.byType(AdaptiveSelectionPicker<String>));
    await tester.pumpAndSettle();

    expect(find.byType(BottomSheet), findsOneWidget);
    expect(find.byType(AppOptionBottomSheet), findsOneWidget);
    expect(find.byType(AppOptionSheetTile), findsNWidgets(2));
    expect(find.byKey(const Key('selection-sheet-handle')), findsOneWidget);

    await tester.tap(find.byKey(const Key('selection-option-SCV')));
    await tester.pumpAndSettle();

    expect(selected, 'SCV');
  });

  testWidgets('uses an anchored contextual menu on wide layouts', (
    tester,
  ) async {
    String? selected;
    await pumpPicker(
      tester,
      width: 1024,
      onSelected: (value) => selected = value,
    );

    await tester.tap(find.byType(AdaptiveSelectionPicker<String>));
    await tester.pumpAndSettle();

    expect(find.byType(BottomSheet), findsNothing);
    expect(find.byType(MenuItemButton), findsNWidgets(2));

    await tester.tap(find.text('SCV'));
    await tester.pumpAndSettle();

    expect(selected, 'SCV');
  });

  testWidgets('uses a restrained option surface in Parchment sheets', (
    tester,
  ) async {
    final package = AppThemePackages.resolve('org.overseer.parchment');
    tester.view.physicalSize = const Size(390, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.fromPackage(package),
        home: Scaffold(
          body: AdaptiveSelectionPicker<String>(
            title: 'Sounds',
            value: 'Peon',
            options: const [
              SelectionOption(value: 'Peon', label: 'Peon'),
              SelectionOption(value: 'SCV', label: 'SCV'),
            ],
            onSelected: (_) {},
          ),
        ),
      ),
    );

    await tester.tap(find.byType(AdaptiveSelectionPicker<String>));
    await tester.pumpAndSettle();

    final unselectedTile = tester.widget<Material>(
      find
          .descendant(
            of: find.byKey(const Key('selection-option-SCV')),
            matching: find.byType(Material),
          )
          .first,
    );
    expect(
      unselectedTile.color,
      AppTheme.fromPackage(package).extension<AppThemePalette>()!.optionSurface,
    );
    expect(unselectedTile.color, isNot(package.surfaceHover));
    expect(unselectedTile.color, isNot(package.surfaceRaised));
  });
}
