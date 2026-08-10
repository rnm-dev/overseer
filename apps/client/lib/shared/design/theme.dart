import 'package:flutter/material.dart';

import 'motion.dart';
import 'spacing.dart';
import 'typography.dart';
import '../../features/themes/app_theme_package.dart';

@immutable
class AppTheme {
  const AppTheme._();

  static ThemeData get dark => fromPackage(AppThemePackages.bundled.first);

  static ThemeData fromPackage(AppThemePackage package) {
    final p = package;
    final colorScheme =
        ColorScheme.fromSeed(
          brightness: p.appearance,
          seedColor: p.accent,
        ).copyWith(
          primary: p.accent,
          onPrimary: p.onAccent,
          primaryContainer: p.accentMuted,
          onPrimaryContainer: p.ink,
          secondary: p.warning,
          onSecondary: p.canvas,
          secondaryContainer: p.warningDeep,
          onSecondaryContainer: p.ink,
          tertiary: p.warningStrong,
          onTertiary: p.onAccent,
          tertiaryContainer: p.inkFaint,
          onTertiaryContainer: p.canvas,
          error: p.danger,
          onError: p.ink,
          errorContainer: p.dangerDeep,
          onErrorContainer: p.ink,
          surface: p.surface,
          onSurface: p.ink,
          onSurfaceVariant: p.inkMuted,
          surfaceContainerHighest: p.surfaceRaised,
          outline: p.edgeStrong,
          outlineVariant: p.edge,
          shadow: p.canvas,
          scrim: p.canvas,
          inverseSurface: p.ink,
          onInverseSurface: p.canvas,
          inversePrimary: p.accentStrong,
          surfaceTint: p.accent,
        );

    final base = ThemeData(brightness: p.appearance, useMaterial3: true);

    return base.copyWith(
      brightness: p.appearance,
      colorScheme: colorScheme,
      scaffoldBackgroundColor: p.canvas,
      canvasColor: p.canvas,
      cardColor: p.surfaceRaised,
      dividerColor: p.edge,
      hoverColor: p.accent.withValues(alpha: 0.10),
      focusColor: p.accent.withValues(alpha: 0.10),
      highlightColor: p.accent.withValues(alpha: 0.14),
      splashColor: p.accent.withValues(alpha: 0.14),
      textTheme: AppTypography.textTheme.apply(
        bodyColor: p.ink,
        displayColor: p.ink,
      ),
      extensions: [const AppSpacing(screenHorizontal: 12), AppThemePalette(p)],
      iconTheme: IconThemeData(color: p.ink),
      appBarTheme: AppBarTheme(
        backgroundColor: p.canvas,
        foregroundColor: p.ink,
        elevation: 0,
        surfaceTintColor: Colors.transparent,
      ),
      cardTheme: CardThemeData(
        color: p.surfaceRaised,
        elevation: 0,
        margin: EdgeInsets.all(0),
        shape: const RoundedRectangleBorder(
          borderRadius: AppMotion.surfaceShape,
        ),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: p.surfaceRaised,
        surfaceTintColor: p.accentMuted,
        shape: const RoundedRectangleBorder(
          borderRadius: AppMotion.surfaceShape,
        ),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: p.surfaceRaised,
        surfaceTintColor: p.accentMuted,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(
            top: Radius.circular(AppMotion.surfaceRadius),
          ),
        ),
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: p.surfaceHover,
        contentTextStyle: AppTypography.body(color: p.ink),
        shape: const RoundedRectangleBorder(
          borderRadius: AppMotion.surfaceShape,
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: p.surfaceHover,
        border: const OutlineInputBorder(borderRadius: AppMotion.controlShape),
        enabledBorder: OutlineInputBorder(
          borderRadius: AppMotion.controlShape,
          borderSide: BorderSide(color: p.edgeStrong),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: AppMotion.controlShape,
          borderSide: BorderSide(color: p.accentStrong),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: AppMotion.controlShape,
          borderSide: BorderSide(color: p.danger),
        ),
        focusedErrorBorder: OutlineInputBorder(
          borderRadius: AppMotion.controlShape,
          borderSide: BorderSide(color: p.dangerDeep),
        ),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: p.accent,
          foregroundColor: p.onAccent,
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
          backgroundColor: p.accent,
          foregroundColor: p.onAccent,
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
          foregroundColor: p.accentStrong,
          side: BorderSide(color: p.accent),
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
          foregroundColor: p.accentStrong,
          shape: const RoundedRectangleBorder(
            borderRadius: AppMotion.controlShape,
          ),
          textStyle: AppTypography.body(fontWeight: FontWeight.w600),
        ),
      ),
      listTileTheme: ListTileThemeData(
        iconColor: p.ink,
        textColor: p.ink,
        tileColor: Colors.transparent,
      ),
    );
  }
}
