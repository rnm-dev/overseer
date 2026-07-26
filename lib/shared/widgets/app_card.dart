import 'package:flutter/material.dart';

import 'package:overseer_mobile/shared/design/motion.dart';
import 'package:overseer_mobile/shared/widgets/surface.dart';

/// A non-interactive content grouping built on the shared surface primitive.
class AppCard extends StatelessWidget {
  const AppCard({
    super.key,
    required this.child,
    this.variant = SurfaceVariant.standard,
    this.padding = const EdgeInsets.all(16),
    this.margin,
    this.borderRadius = AppMotion.surfaceShape,
  });

  final Widget child;
  final SurfaceVariant variant;
  final EdgeInsetsGeometry padding;
  final EdgeInsetsGeometry? margin;
  final BorderRadius borderRadius;

  @override
  Widget build(BuildContext context) {
    return Surface(
      variant: variant,
      padding: padding,
      margin: margin,
      borderRadius: borderRadius,
      child: child,
    );
  }
}
