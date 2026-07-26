import 'package:flutter/material.dart';

@immutable
class AppSpacing extends ThemeExtension<AppSpacing> {
  const AppSpacing({this.screenHorizontal = 12});

  static const double xxs = 4;
  static const double xs = 8;
  static const double sm = 12;
  static const double md = 16;
  static const double lg = 24;
  static const double xl = 32;
  static const double xxl = 48;

  final double screenHorizontal;

  EdgeInsets screenInsets({double top = 0, double bottom = 0}) {
    return EdgeInsets.fromLTRB(screenHorizontal, top, screenHorizontal, bottom);
  }

  @override
  AppSpacing copyWith({double? screenHorizontal}) {
    return AppSpacing(
      screenHorizontal: screenHorizontal ?? this.screenHorizontal,
    );
  }

  @override
  AppSpacing lerp(covariant AppSpacing? other, double t) {
    if (other == null) {
      return this;
    }
    return AppSpacing(
      screenHorizontal:
          screenHorizontal + (other.screenHorizontal - screenHorizontal) * t,
    );
  }
}

extension AppSpacingContext on BuildContext {
  AppSpacing get appSpacing {
    return Theme.of(this).extension<AppSpacing>() ?? const AppSpacing();
  }
}
