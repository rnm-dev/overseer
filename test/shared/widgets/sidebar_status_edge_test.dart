import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/shared/design/colors.dart';
import 'package:overseer_mobile/shared/design/theme.dart';
import 'package:overseer_mobile/shared/widgets/sidebar_status_edge.dart';

void main() {
  testWidgets('idle live updates flare with the web fel fallback', (
    tester,
  ) async {
    final revision = ValueNotifier(0);
    addTearDown(revision.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Center(
          child: SizedBox(
            height: 40,
            child: ValueListenableBuilder<int>(
              valueListenable: revision,
              builder: (context, value, _) => SidebarStatusEdge(
                key: const Key('edge'),
                style: SidebarStatusEdgeStyle.idle,
                semanticLabel: 'Idle',
                flashRevision: value,
              ),
            ),
          ),
        ),
      ),
    );

    expect(_decoration(tester).boxShadow, isNull);
    revision.value = 1;
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 87));

    final shadows = _decoration(tester).boxShadow!;
    expect(shadows, hasLength(3));
    expect(shadows.first.color.withValues(alpha: 1), AppColors.fel);
    expect(find.bySemanticsLabel('Idle'), findsOneWidget);

    await tester.pumpAndSettle();
    expect(_decoration(tester).boxShadow, isNull);
  });

  testWidgets('reduced motion keeps the edge steady during live updates', (
    tester,
  ) async {
    final revision = ValueNotifier(0);
    addTearDown(revision.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: MediaQuery(
          data: const MediaQueryData(disableAnimations: true),
          child: Center(
            child: SizedBox(
              height: 40,
              child: ValueListenableBuilder<int>(
                valueListenable: revision,
                builder: (context, value, _) => SidebarStatusEdge(
                  key: const Key('edge'),
                  style: SidebarStatusEdgeStyle.idle,
                  semanticLabel: 'Idle',
                  flashRevision: value,
                ),
              ),
            ),
          ),
        ),
      ),
    );

    revision.value = 1;
    await tester.pump();
    expect(_decoration(tester).boxShadow, isNull);
    expect(tester.hasRunningAnimations, isFalse);
  });
}

BoxDecoration _decoration(WidgetTester tester) {
  final container = find
      .descendant(
        of: find.byKey(const Key('edge')),
        matching: find.byType(Container),
      )
      .first;
  return tester.widget<Container>(container).decoration! as BoxDecoration;
}
