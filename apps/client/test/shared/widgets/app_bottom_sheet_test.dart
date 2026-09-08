import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/shared/design/theme.dart';
import 'package:overseer_mobile/shared/design/typography.dart';
import 'package:overseer_mobile/shared/widgets/app_bottom_sheet.dart';

void main() {
  testWidgets('uses the shared title style when a title is provided', (
    tester,
  ) async {
    _setViewport(tester, const Size(390, 844));
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: const Scaffold(
          body: AppBottomSheet(title: 'Sheet title', children: [Text('Body')]),
        ),
      ),
    );

    final titleFinder = find.byKey(const Key('app-bottom-sheet-title'));
    final title = tester.widget<Text>(titleFinder);
    expect(title.data, 'Sheet title');
    expect(
      title.style,
      AppTypography.sectionTitle(
        color: Theme.of(tester.element(titleFinder)).colorScheme.onSurface,
      ),
    );
    expect(
      tester.getTopLeft(find.byKey(const Key('app-bottom-sheet-title'))).dx,
      tester.getTopLeft(find.text('Body')).dx,
    );
  });

  testWidgets('does not reserve title space when title is omitted', (
    tester,
  ) async {
    _setViewport(tester, const Size(390, 844));
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: const Scaffold(body: AppBottomSheet(children: [Text('Body')])),
      ),
    );

    expect(find.byKey(const Key('app-bottom-sheet-title')), findsNothing);
    expect(find.text('Body'), findsOneWidget);
  });

  testWidgets('keeps the mobile bottom sheet and drag handle', (tester) async {
    _setViewport(tester, const Size(390, 844));
    await tester.pumpWidget(_launcher());

    await tester.tap(find.text('Show'));
    await tester.pumpAndSettle();

    expect(find.byType(BottomSheet), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);
    expect(find.byKey(const Key('mobile-sheet-handle')), findsOneWidget);
  });

  testWidgets('uses a bounded centered dialog on desktop', (tester) async {
    _setViewport(tester, const Size(1200, 800));
    await tester.pumpWidget(
      _launcher(
        sheet: (_) => AppBottomSheet(
          title: 'Desktop sheet',
          handleKey: const Key('desktop-sheet-handle'),
          children: const [Text('Body')],
        ),
      ),
    );

    await tester.tap(find.text('Show'));
    await tester.pumpAndSettle();

    expect(find.byType(BottomSheet), findsNothing);
    expect(find.byType(Dialog), findsOneWidget);
    expect(find.byKey(const Key('desktop-sheet-handle')), findsNothing);

    final sheet = find.byType(AppBottomSheet);
    final rect = tester.getRect(sheet);
    expect(rect.width, lessThanOrEqualTo(560));
    expect(rect.center, const Offset(600, 400));
    expect(
      tester
          .widget<Material>(
            find.descendant(of: sheet, matching: find.byType(Material)),
          )
          .shape,
      const RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(28)),
      ),
    );
  });

  testWidgets('scrolls ordinary desktop content without overflowing', (
    tester,
  ) async {
    _setViewport(tester, const Size(900, 220));
    await tester.pumpWidget(
      _launcher(
        sheet: (_) => AppBottomSheet(
          title: 'Long sheet',
          children: [
            for (var index = 0; index < 40; index++) Text('Row $index'),
          ],
        ),
      ),
    );

    await tester.tap(find.text('Show'));
    await tester.pumpAndSettle();

    expect(find.byType(SingleChildScrollView), findsOneWidget);
    expect(tester.getRect(find.byType(AppBottomSheet)).height, lessThan(220));
    expect(tester.takeException(), isNull);
  });

  testWidgets('preserves callers that provide their own expanded scroll view', (
    tester,
  ) async {
    _setViewport(tester, const Size(900, 500));
    await tester.pumpWidget(
      _launcher(
        sheet: (_) => AppBottomSheet(
          children: [
            Expanded(
              child: ListView(
                key: const Key('caller-owned-scroll-view'),
                children: const [Text('Scrollable body')],
              ),
            ),
          ],
        ),
      ),
    );

    await tester.tap(find.text('Show'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('caller-owned-scroll-view')), findsOneWidget);
    expect(find.byType(SingleChildScrollView), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('does not add a flex scroll viewport to unbounded callers', (
    tester,
  ) async {
    _setViewport(tester, const Size(900, 500));
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: SingleChildScrollView(
            child: AppBottomSheet(children: const [Text('Caller-owned body')]),
          ),
        ),
      ),
    );

    expect(find.text('Caller-owned body'), findsOneWidget);
    expect(find.byType(SingleChildScrollView), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('accounts for keyboard insets on desktop', (tester) async {
    _setViewport(tester, const Size(900, 600));
    tester.view.viewInsets = const FakeViewPadding(bottom: 300);
    addTearDown(tester.view.resetViewInsets);
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => unawaited(
                showAppBottomSheet<void>(
                  context: context,
                  builder: (_) => const AppBottomSheet(
                    title: 'Keyboard sheet',
                    children: [Text('Body')],
                  ),
                ),
              ),
              child: const Text('Show'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Show'));
    await tester.pumpAndSettle();

    expect(tester.getRect(find.byType(AppBottomSheet)).bottom, lessThan(300));
    expect(tester.takeException(), isNull);
  });

  testWidgets('Escape dismisses a dismissible desktop dialog', (tester) async {
    _setViewport(tester, const Size(900, 600));
    await tester.pumpWidget(_launcher());

    await tester.tap(find.text('Show'));
    await tester.pumpAndSettle();
    expect(find.text('Body'), findsOneWidget);

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();

    expect(find.text('Body'), findsNothing);
  });
}

void _setViewport(WidgetTester tester, Size size) {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
}

Widget _launcher({WidgetBuilder sheet = _defaultSheet}) {
  return MaterialApp(
    theme: AppTheme.dark,
    home: Builder(
      builder: (context) => Scaffold(
        body: TextButton(
          onPressed: () => unawaited(
            showAppBottomSheet<void>(context: context, builder: sheet),
          ),
          child: const Text('Show'),
        ),
      ),
    ),
  );
}

Widget _defaultSheet(BuildContext context) {
  return AppBottomSheet(
    handleKey: const Key('mobile-sheet-handle'),
    children: const [Text('Body')],
  );
}
