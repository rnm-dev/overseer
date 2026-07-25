import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:overseer_mobile/shared/design/colors.dart';
import 'package:overseer_mobile/shared/design/motion.dart';
import 'package:overseer_mobile/shared/design/spacing.dart';
import 'package:overseer_mobile/shared/design/theme.dart';
import 'package:overseer_mobile/shared/design/typography.dart';

void main() {
  group('AppTheme.dark', () {
    test('uses the global eight-pixel screen gutter', () {
      final spacing = AppTheme.dark.extension<AppSpacing>();

      expect(spacing, isNotNull);
      expect(spacing!.screenHorizontal, 8);
      expect(
        spacing.screenInsets(top: 12, bottom: 32),
        const EdgeInsets.fromLTRB(8, 12, 8, 32),
      );
    });

    test('is Material 3 dark and maps core palette', () {
      final theme = AppTheme.dark;

      expect(theme.useMaterial3, true);
      expect(theme.brightness, Brightness.dark);
      expect(theme.scaffoldBackgroundColor, AppColors.voidColor);
      expect(theme.colorScheme.primary, AppColors.fel);
      expect(theme.colorScheme.secondary, AppColors.forge);
      expect(theme.colorScheme.error, AppColors.blood);
      expect(theme.colorScheme.surface, AppColors.iron950);
      expect(theme.colorScheme.onSurface, AppColors.bone);
      expect(theme.hoverColor, AppColors.fel.withValues(alpha: 0.10));
      expect(theme.focusColor, theme.hoverColor);
      expect(theme.highlightColor, AppColors.fel.withValues(alpha: 0.14));
      expect(theme.splashColor, theme.highlightColor);
    });

    test('applies shared surfaces and controls geometry', () {
      final theme = AppTheme.dark;
      final cardShape = theme.cardTheme.shape;
      final buttonShape = theme.elevatedButtonTheme.style?.shape?.resolve(
        const {WidgetState.pressed, WidgetState.hovered},
      );

      expect(cardShape, isA<RoundedRectangleBorder>());
      final rounded = cardShape as RoundedRectangleBorder;
      expect(rounded.borderRadius, AppMotion.surfaceShape);
      expect(buttonShape, isNotNull);
      expect(theme.textTheme.bodyLarge?.fontFamily, AppTypography.fontFamily);
      expect(AppTypography.display().fontFamily, AppTypography.fontFamily);
      expect(AppTypography.body().fontFamily, AppTypography.fontFamily);
      expect(AppTypography.display().fontSize, isNull);
      expect(AppTypography.body(color: AppColors.fel).color, AppColors.fel);
      expect(AppTypography.mono(fontSize: 12).fontFamily, 'monospace');
    });
  });
}
