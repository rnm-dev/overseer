import 'package:flutter/material.dart';

@immutable
class AppMotion {
  const AppMotion._();

  static const double surfaceRadius = 12.0;
  static const double controlRadius = 6.0;
  static const double optionRadius = 14.0;
  static const Radius surfaceRadiusValue = Radius.circular(surfaceRadius);
  static const Radius controlRadiusValue = Radius.circular(controlRadius);
  static const Radius optionRadiusValue = Radius.circular(optionRadius);
  static const BorderRadius surfaceShape = BorderRadius.all(surfaceRadiusValue);
  static const BorderRadius controlShape = BorderRadius.all(controlRadiusValue);
  static const BorderRadius optionShape = BorderRadius.all(optionRadiusValue);

  static const Duration fast = Duration(milliseconds: 160);
  static const Duration base = Duration(milliseconds: 180);
  static const Duration panelOpen = Duration(milliseconds: 420);
  static const Duration panelClose = Duration(milliseconds: 300);
  static const Duration backdropFade = Duration(milliseconds: 260);
  static const Duration drawerMotion = Duration(milliseconds: 380);

  static const Cubic iosQuick = Cubic(0.32, 0.72, 0.0, 1.0);
  static const Cubic modalSettle = Cubic(0.2, 0.8, 0.2, 1.0);
  static const Cubic softSettle = Curves.easeOutCubic;
}
