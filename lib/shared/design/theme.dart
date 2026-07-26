import 'package:flutter/material.dart';

import 'colors.dart';
import 'motion.dart';
import 'spacing.dart';
import 'typography.dart';

@immutable
class AppTheme {
  const AppTheme._();

  static ThemeData get dark {
    final colorScheme =
        ColorScheme.fromSeed(
          brightness: Brightness.dark,
          seedColor: AppColors.fel,
        ).copyWith(
          primary: AppColors.fel,
          onPrimary: AppColors.felInk,
          primaryContainer: AppColors.felDim,
          onPrimaryContainer: AppColors.bone,
          secondary: AppColors.forge,
          onSecondary: AppColors.voidColor,
          secondaryContainer: AppColors.forgeDeep,
          onSecondaryContainer: AppColors.bone,
          tertiary: AppColors.ember,
          onTertiary: AppColors.felInk,
          tertiaryContainer: AppColors.boneFaint,
          onTertiaryContainer: AppColors.voidColor,
          error: AppColors.blood,
          onError: AppColors.bone,
          errorContainer: AppColors.rust,
          onErrorContainer: AppColors.bone,
          surface: AppColors.iron950,
          onSurface: AppColors.bone,
          surfaceContainerHighest: AppColors.iron900,
          outline: AppColors.iron600,
          outlineVariant: AppColors.iron700,
          shadow: AppColors.voidColor,
          scrim: AppColors.voidColor,
          inverseSurface: AppColors.bone,
          onInverseSurface: AppColors.voidColor,
          inversePrimary: AppColors.felBright,
          surfaceTint: AppColors.fel,
        );

    final base = ThemeData.dark(useMaterial3: true);

    return base.copyWith(
      brightness: Brightness.dark,
      colorScheme: colorScheme,
      scaffoldBackgroundColor: AppColors.voidColor,
      canvasColor: AppColors.voidColor,
      cardColor: AppColors.iron900,
      dividerColor: AppColors.iron700,
      hoverColor: AppColors.fel.withValues(alpha: 0.10),
      focusColor: AppColors.fel.withValues(alpha: 0.10),
      highlightColor: AppColors.fel.withValues(alpha: 0.14),
      splashColor: AppColors.fel.withValues(alpha: 0.14),
      textTheme: AppTypography.textTheme,
      extensions: const [AppSpacing(screenHorizontal: 12)],
      iconTheme: const IconThemeData(color: AppColors.bone),
      appBarTheme: const AppBarTheme(
        backgroundColor: AppColors.voidColor,
        foregroundColor: AppColors.bone,
        elevation: 0,
        surfaceTintColor: Colors.transparent,
      ),
      cardTheme: const CardThemeData(
        color: AppColors.iron900,
        elevation: 0,
        margin: EdgeInsets.all(0),
        shape: RoundedRectangleBorder(borderRadius: AppMotion.surfaceShape),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: AppColors.iron900,
        surfaceTintColor: AppColors.felDim,
        shape: const RoundedRectangleBorder(
          borderRadius: AppMotion.surfaceShape,
        ),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: AppColors.iron900,
        surfaceTintColor: AppColors.felDim,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(
            top: Radius.circular(AppMotion.surfaceRadius),
          ),
        ),
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: AppColors.iron800,
        contentTextStyle: AppTypography.body(color: AppColors.bone),
        shape: const RoundedRectangleBorder(
          borderRadius: AppMotion.surfaceShape,
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: AppColors.rowSurface,
        border: const OutlineInputBorder(borderRadius: AppMotion.controlShape),
        enabledBorder: const OutlineInputBorder(
          borderRadius: AppMotion.controlShape,
          borderSide: BorderSide(color: AppColors.iron600),
        ),
        focusedBorder: const OutlineInputBorder(
          borderRadius: AppMotion.controlShape,
          borderSide: BorderSide(color: AppColors.felBright),
        ),
        errorBorder: const OutlineInputBorder(
          borderRadius: AppMotion.controlShape,
          borderSide: BorderSide(color: AppColors.blood),
        ),
        focusedErrorBorder: const OutlineInputBorder(
          borderRadius: AppMotion.controlShape,
          borderSide: BorderSide(color: AppColors.rust),
        ),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: AppColors.fel,
          foregroundColor: AppColors.felInk,
          shape: const RoundedRectangleBorder(
            borderRadius: AppMotion.controlShape,
          ),
          textStyle: AppTypography.body(fontWeight: FontWeight.w600),
          elevation: 0,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          minimumSize: const Size(0, 44),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: AppColors.fel,
          foregroundColor: AppColors.felInk,
          shape: const RoundedRectangleBorder(
            borderRadius: AppMotion.controlShape,
          ),
          textStyle: AppTypography.body(fontWeight: FontWeight.w600),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          minimumSize: const Size(0, 44),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: AppColors.felBright,
          side: const BorderSide(color: AppColors.fel),
          shape: const RoundedRectangleBorder(
            borderRadius: AppMotion.controlShape,
          ),
          textStyle: AppTypography.body(fontWeight: FontWeight.w600),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          minimumSize: const Size(0, 44),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: AppColors.felBright,
          shape: const RoundedRectangleBorder(
            borderRadius: AppMotion.controlShape,
          ),
          textStyle: AppTypography.body(fontWeight: FontWeight.w600),
        ),
      ),
      listTileTheme: const ListTileThemeData(
        iconColor: AppColors.bone,
        textColor: AppColors.bone,
        tileColor: Colors.transparent,
      ),
    );
  }
}
