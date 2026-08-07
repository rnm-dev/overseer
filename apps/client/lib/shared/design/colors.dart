import 'package:flutter/material.dart';

export '../../features/themes/domain/app_theme_package.dart'
    show AppThemePackage, AppThemePackages, AppThemePalette;

@immutable
class AppColors {
  const AppColors._();

  // calm dark palette
  static const Color voidColor = Color(0xFF0B0C0B);

  static const Color iron950 = Color(0xFF111311);
  static const Color iron900 = Color(0xFF171916);
  static const Color iron800 = Color(0xFF262A23);
  static const Color iron700 = Color(0xFF343931);
  static const Color iron600 = Color(0xFF474D42);
  static const Color iron500 = Color(0xFF5C6353);
  static const Color rowSurface = Color(0xFF1F221D);

  static const Color fel = Color(0xFF86AB63);
  static const Color felBright = Color(0xFFA6C78A);
  static const Color felDeep = Color(0xFF5C7A41);
  static const Color felDim = Color(0xFF3A4B2A);
  static const Color felInk = Color(0xFF0B1305);

  static const Color forge = Color(0xFFD99441);
  static const Color forgeDeep = Color(0xFF8D5624);
  static const Color ember = Color(0xFFE6B877);

  static const Color blood = Color(0xFFD95F48);
  static const Color rust = Color(0xFFA53A29);

  static const Color bone = Color(0xFFE7E6DC);
  static const Color boneDim = Color(0xFF9A9C8E);
  static const Color boneFaint = Color(0xFF64685A);

  // Semantic aliases for quick reuse
  static const Color background = voidColor;
  static const Color onBackground = bone;
  static const Color surface = iron950;
  static const Color onSurface = bone;
  static const Color controlSurface = iron900;
}
