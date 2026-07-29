import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/shared/widgets/app_navigation_bar.dart';

void main() {
  testWidgets(
    'renders configurable left and right content without back button',
    (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: AppNavigationBar(
              left: Text('Left view'),
              right: Text('Right view'),
            ),
          ),
        ),
      );

      expect(find.text('Left view'), findsOneWidget);
      expect(find.text('Right view'), findsOneWidget);
      expect(find.byTooltip('Back'), findsNothing);
      expect(
        tester.getSize(find.byType(AppNavigationBar)).height,
        AppNavigationBar.fixedContentHeight,
      );
    },
  );

  testWidgets('shows back button and invokes its override', (tester) async {
    var backPressed = false;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AppNavigationBar(
            showBackButton: true,
            onBack: () => backPressed = true,
          ),
        ),
      ),
    );

    await tester.tap(find.byTooltip('Back'));

    expect(backPressed, isTrue);
  });

  testWidgets('can reduce the top safe-area inset', (tester) async {
    await tester.pumpWidget(
      const MediaQuery(
        data: MediaQueryData(padding: EdgeInsets.only(top: 24)),
        child: MaterialApp(
          home: Scaffold(
            body: AppNavigationBar(key: Key('navbar'), topInsetReduction: 8),
          ),
        ),
      ),
    );

    expect(tester.getSize(find.byKey(const Key('navbar'))).height, 72);
  });
}
