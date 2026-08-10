import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:overseer_mobile/features/themes/app_theme_package.dart';
import 'package:overseer_mobile/shared/design/theme.dart';
import 'package:overseer_mobile/shared/widgets/loading_shimmer.dart';

void main() {
  testWidgets('light-theme skeleton uses the darker hover surface', (
    tester,
  ) async {
    final package = AppThemePackages.resolve('org.overseer.parchment');
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.fromPackage(package),
        home: const ShimmerBlock(width: 40, height: 12),
      ),
    );

    final container = tester.widget<Container>(find.byType(Container));
    final decoration = container.decoration! as BoxDecoration;
    expect(decoration.color, package.surfaceHover);
    expect(decoration.color, isNot(package.surfaceRaised));
  });
}
