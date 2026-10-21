import 'package:flutter/widgets.dart';

@immutable
class AppSpacing {
  const AppSpacing();

  static const double xxs = 4;
  static const double xs = 8;
  static const double sm = 12;
  static const double lg = 24;

  /// Global horizontal screen gutter.
  double get screenHorizontal => 12;

  EdgeInsets screenInsets({double top = 0, double bottom = 0}) {
    return EdgeInsets.fromLTRB(screenHorizontal, top, screenHorizontal, bottom);
  }
}

extension AppSpacingContext on BuildContext {
  AppSpacing get appSpacing => const AppSpacing();
}
