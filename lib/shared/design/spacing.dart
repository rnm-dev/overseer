import 'package:flutter/material.dart';

@immutable
class AppSpacing extends ThemeExtension<AppSpacing> {
  const AppSpacing({this.screenHorizontal = 8});

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
