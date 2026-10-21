import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/shared/widgets/app_list_tile.dart';

void main() {
  group('AppListTile', () {
    testWidgets('renders text and applies semantics', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AppListTile(
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
      final node = tester.getSemantics(find.byType(AppListTile));
      expect(node.label, contains('Session alpha row'));
      expect(node.flagsCollection.isSelected, ui.Tristate.isTrue);
      expect(node.flagsCollection.isEnabled, ui.Tristate.isTrue);
    });

    testWidgets('respects callbacks and titleMaxLines', (
      WidgetTester tester,
    ) async {
      int taps = 0;
      int longPresses = 0;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AppListTile(
              title:
                  'A very long title that should still be clamped by maxLines.',
              titleMaxLines: 2,
              onTap: () => taps += 1,
              onLongPress: () => longPresses += 1,
              trailing: const Icon(Icons.more_horiz),
            ),
          ),
        ),
      );

      final Text titleText = tester.widget<Text>(find.byType(Text).first);
      expect(titleText.maxLines, 2);

      await tester.tap(find.byType(AppListTile));
      await tester.pumpAndSettle();

      await tester.longPress(find.byType(AppListTile));
      await tester.pumpAndSettle();

      expect(taps, 1);
      expect(longPresses, 1);
    });
  });
}
