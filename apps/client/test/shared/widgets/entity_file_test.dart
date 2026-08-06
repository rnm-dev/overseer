import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:overseer_mobile/shared/design/colors.dart';
import 'package:overseer_mobile/shared/design/theme.dart';
import 'package:overseer_mobile/shared/widgets/app_list_tile.dart';
import 'package:overseer_mobile/shared/widgets/entity_list_tile.dart';
import 'package:overseer_mobile/shared/widgets/file_type_icon.dart';

void main() {
  group('FileTypeIcon classifier', () {
    test('classifies extension groups consistently', () {
      expect(fileKindForName('main.js'), FileKind.javascript);
      expect(fileKindForName('App.TSX'), FileKind.typescript);
      expect(fileKindForName('theme.scss'), FileKind.stylesheet);
      expect(fileKindForName('Dockerfile'), FileKind.shell);
      expect(fileKindForName('README.txt'), FileKind.text);
      expect(fileKindForName('notes'), FileKind.unknown);
      expect(fileKindForName('.gitignore'), FileKind.unknown);
    });

    testWidgets('maps kinds to Lucide icon colors', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Row(
              children: <Widget>[
                const FileTypeIcon(name: 'bundle.js'),
                const FileTypeIcon(name: 'main.ts'),
                const FileTypeIcon(name: 'unknown.ext'),
              ],
            ),
          ),
        ),
      );

      final List<Icon> icons = tester
          .widgetList<Icon>(find.byType(Icon))
          .toList();
      expect(icons[0].icon, LucideIcons.fileCode);
      final theme = AppThemePackages.bundled.first;
      expect(icons[0].color, theme.warning);
      expect(icons[1].icon, LucideIcons.fileCode);
      expect(icons[1].color, theme.ink);
      expect(icons[2].color, theme.inkFaint);
    });
  });

  group('EntityListTile', () {
    testWidgets('renders text and applies semantics', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: EntityListTile(
              title: 'Session alpha',
              subtitle: 'active',
              selected: true,
              onTap: () {},
              semanticsLabel: 'Session alpha row',
            ),
          ),
        ),
      );

      expect(find.text('Session alpha'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(EntityListTile),
          matching: find.byType(AppListTile),
        ),
        findsOneWidget,
      );
      final node = tester.getSemantics(find.byType(EntityListTile));
      expect(node.label, contains('Session alpha row'));
      expect(node.flagsCollection.isSelected, isNot(ui.Tristate.none));
      expect(node.flagsCollection.isSelected, ui.Tristate.isTrue);
      expect(node.flagsCollection.isEnabled, ui.Tristate.isTrue);
    });

    testWidgets('respects callbacks and maxLines', (WidgetTester tester) async {
      int taps = 0;
      int longPresses = 0;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: EntityListTile(
              title:
                  'A very long title that should still be clamped by maxLines.',
              maxLines: 2,
              onTap: () => taps += 1,
              onLongPress: () => longPresses += 1,
              trailing: const Icon(Icons.more_horiz),
            ),
          ),
        ),
      );

      final Text titleText = tester.widget<Text>(find.byType(Text).first);
      expect(titleText.maxLines, 2);

      await tester.tap(find.byType(EntityListTile));
      await tester.pumpAndSettle();

      await tester.longPress(find.byType(EntityListTile));
      await tester.pumpAndSettle();

      expect(taps, 1);
      expect(longPresses, 1);
    });
  });
}
