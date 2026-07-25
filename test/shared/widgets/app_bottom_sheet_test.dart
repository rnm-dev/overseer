import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/shared/design/theme.dart';
import 'package:overseer_mobile/shared/design/typography.dart';
import 'package:overseer_mobile/shared/widgets/app_bottom_sheet.dart';

void main() {
  testWidgets('uses the shared title style when a title is provided', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: const Scaffold(
          body: AppBottomSheet(title: 'Sheet title', children: [Text('Body')]),
        ),
      ),
    );

    final title = tester.widget<Text>(
      find.byKey(const Key('app-bottom-sheet-title')),
    );
    expect(title.data, 'Sheet title');
    expect(title.style, AppTypography.sectionTitle());
  });

  testWidgets('does not reserve title space when title is omitted', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: const Scaffold(body: AppBottomSheet(children: [Text('Body')])),
      ),
    );

    expect(find.byKey(const Key('app-bottom-sheet-title')), findsNothing);
    expect(find.text('Body'), findsOneWidget);
  });
}
