import 'package:flutter/widgets.dart';

abstract final class AppSpacing {
  static const double xxs = 4;
  static const double xs = 8;
  static const double sm = 12;
  static const double lg = 24;

  /// Global horizontal screen gutter.
  static const double screenHorizontal = 12;

  static EdgeInsets screenInsets({double top = 0, double bottom = 0}) {
    return EdgeInsets.fromLTRB(screenHorizontal, top, screenHorizontal, bottom);
  }
}
