import 'package:flutter/material.dart';

import 'package:overseer_mobile/shared/design/motion.dart';

enum SurfaceVariant { standard, subtle, inset }

/// A non-interactive bordered content grouping.
class AppCard extends StatelessWidget {
  const AppCard({
    super.key,
    required this.child,
    this.variant = SurfaceVariant.standard,
    this.padding = const EdgeInsets.all(16),
  });

  final Widget child;
  final SurfaceVariant variant;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final (background, border) = switch (variant) {
      SurfaceVariant.standard => (
        colors.surfaceContainerHighest,
        colors.outlineVariant,
      ),
      SurfaceVariant.subtle => (
        colors.surfaceContainerHighest.withValues(alpha: 0.6),
        colors.outlineVariant,
      ),
      SurfaceVariant.inset => (
        colors.surface.withValues(alpha: 0.58),
        colors.outline.withValues(alpha: 0.8),
      ),
    };
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: background,
        border: Border.all(color: border),
        borderRadius: AppMotion.surfaceShape,
      ),
      child: child,
    );
  }
}
