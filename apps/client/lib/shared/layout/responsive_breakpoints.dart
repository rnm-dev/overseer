import 'package:flutter/foundation.dart';

enum ResponsiveLayoutSize { compact, medium, wide }

@immutable
class ResponsiveBreakpoints {
  const ResponsiveBreakpoints._();

  static const double medium = 600;
  static const double wide = 1024;

  static ResponsiveLayoutSize sizeFor(double width) {
    if (width < medium) {
      return ResponsiveLayoutSize.compact;
    }
    if (width < wide) {
      return ResponsiveLayoutSize.medium;
    }
    return ResponsiveLayoutSize.wide;
  }
}
