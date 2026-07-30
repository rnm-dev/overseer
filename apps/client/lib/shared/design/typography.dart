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

  static TextStyle chatMessage({
    Color? color,
    FontWeight? fontWeight,
    double? height,
  }) {
    return body(
      fontSize: 14,
      fontWeight: fontWeight ?? FontWeight.w400,
      color: color ?? AppColors.bone,
      height: height ?? 1.35,
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
      fontSize: 17,
      fontWeight: FontWeight.w600,
      color: color ?? AppColors.bone,
      height: 1.25,
      letterSpacing: -0.15,
    );
  }

  static TextStyle pageTitle({Color? color}) {
    return display(
      fontSize: 24,
      fontWeight: FontWeight.w700,
      color: color ?? AppColors.bone,
      height: 1.2,
      letterSpacing: -0.35,
    );
  }

  static TextStyle sectionLabel({Color? color}) {
    return body(
      fontSize: 11,
      fontWeight: FontWeight.w600,
      color: color ?? AppColors.boneDim,
      height: 1.2,
      letterSpacing: 1.1,
    );
  }

  static TextStyle entityTitle({Color? color}) {
    return body(
      fontSize: 15,
      fontWeight: FontWeight.w600,
      color: color,
      height: 1.25,
    );
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
