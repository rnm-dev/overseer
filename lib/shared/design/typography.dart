import 'package:flutter/material.dart';
import 'colors.dart';

@immutable
class AppTypography {
  const AppTypography._();

  static const String fontFamily = 'Golos Text';

  static const List<String> monoFallbacks = <String>[
    'Menlo',
    'Consolas',
    'Courier New',
  ];

  static TextStyle display({
    double? fontSize,
    FontWeight? fontWeight,
    Color? color,
    double? height,
    double? letterSpacing,
  }) {
    return TextStyle(
      fontFamily: fontFamily,
      fontSize: fontSize,
      fontWeight: fontWeight ?? FontWeight.w600,
      color: color ?? AppColors.bone,
      height: height,
      letterSpacing: letterSpacing,
    );
  }

  static TextStyle body({
    double? fontSize,
    FontWeight? fontWeight,
    Color? color,
    double? height,
    double? letterSpacing,
  }) {
    return TextStyle(
      fontFamily: fontFamily,
      fontSize: fontSize,
      fontWeight: fontWeight ?? FontWeight.w400,
      color: color ?? AppColors.bone,
      height: height,
      letterSpacing: letterSpacing,
    );
  }

  static TextStyle mono({
    double? fontSize,
    FontWeight? fontWeight,
    Color? color,
    double? height,
    double? letterSpacing,
  }) {
    return TextStyle(
      fontFamily: 'monospace',
      fontFamilyFallback: monoFallbacks,
      fontSize: fontSize,
      fontWeight: fontWeight ?? FontWeight.w400,
      color: color ?? AppColors.bone,
      height: height,
      letterSpacing: letterSpacing,
    );
  }

  // Semantic product roles. Keep feature widgets free of font-size literals so
  // the visual hierarchy can be tuned from one place.
  static TextStyle sectionTitle({Color? color}) {
    return display(
      fontSize: 18,
      fontWeight: FontWeight.w700,
      color: color ?? AppColors.felBright,
      letterSpacing: 0.6,
    );
  }

  static TextStyle entityTitle({Color? color}) {
    return body(fontSize: 15, fontWeight: FontWeight.w600, color: color);
  }

  static TextStyle controlLabel({Color? color}) {
    return body(fontSize: 14, fontWeight: FontWeight.w600, color: color);
  }

  static TextStyle controlValue({Color? color}) {
    return mono(fontSize: 13, color: color ?? AppColors.boneDim);
  }

  static TextStyle metadata({Color? color}) {
    return mono(fontSize: 12, color: color ?? AppColors.boneDim);
  }

  static TextStyle optionLabel({required bool selected}) {
    return body(
      fontSize: 14,
      fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
      color: selected ? AppColors.felBright : AppColors.bone,
    );
  }

  static final TextTheme textTheme = TextTheme(
    displayLarge: display(
      fontSize: 57,
      fontWeight: FontWeight.w600,
      height: 1.2,
    ),
    displayMedium: display(
      fontSize: 45,
      fontWeight: FontWeight.w600,
      height: 1.2,
    ),
    displaySmall: display(
      fontSize: 36,
      fontWeight: FontWeight.w500,
      height: 1.25,
    ),
    headlineLarge: display(
      fontSize: 32,
      fontWeight: FontWeight.w600,
      height: 1.25,
    ),
    headlineMedium: display(
      fontSize: 28,
      fontWeight: FontWeight.w600,
      height: 1.28,
    ),
    headlineSmall: display(
      fontSize: 24,
      fontWeight: FontWeight.w500,
      height: 1.3,
    ),
    titleLarge: display(
      fontSize: 22,
      fontWeight: FontWeight.w500,
      height: 1.27,
    ),
    titleMedium: body(fontSize: 16, fontWeight: FontWeight.w500, height: 1.3),
    titleSmall: body(fontSize: 14, fontWeight: FontWeight.w500, height: 1.35),
    bodyLarge: body(fontSize: 16, height: 1.45),
    bodyMedium: body(fontSize: 14, height: 1.4),
    bodySmall: body(fontSize: 12, height: 1.35),
    labelLarge: body(fontSize: 14, fontWeight: FontWeight.w600, height: 1.1),
    labelMedium: body(fontSize: 12, fontWeight: FontWeight.w600, height: 1.05),
    labelSmall: body(fontSize: 11, fontWeight: FontWeight.w600, height: 1.0),
  );
}
