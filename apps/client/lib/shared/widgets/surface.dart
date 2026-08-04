import 'package:flutter/material.dart';

import 'package:overseer_mobile/shared/design/motion.dart';
import 'package:overseer_mobile/features/themes/domain/app_theme_package.dart';

enum SurfaceVariant { standard, subtle, inset, lit }

class Surface extends StatefulWidget {
  const Surface({
    super.key,
    this.variant = SurfaceVariant.standard,
    this.interactive = false,
    this.onTap,
    this.child,
    this.padding = EdgeInsets.zero,
    this.margin,
    this.alignment,
    this.borderRadius = const BorderRadius.all(Radius.circular(12)),
    this.width,
    this.height,
  });

  final SurfaceVariant variant;
  final bool interactive;
  final VoidCallback? onTap;
  final Widget? child;
  final EdgeInsetsGeometry padding;
  final EdgeInsetsGeometry? margin;
  final AlignmentGeometry? alignment;
  final BorderRadius borderRadius;
  final double? width;
  final double? height;

  bool get _isInteractive => interactive || onTap != null;

  Color _baseBackground(ColorScheme colors) {
    switch (variant) {
      case SurfaceVariant.standard:
        return colors.surfaceContainerHighest;
      case SurfaceVariant.subtle:
        return colors.surfaceContainerHighest.withValues(alpha: 0.6);
      case SurfaceVariant.inset:
        return colors.surface.withValues(alpha: 0.58);
      case SurfaceVariant.lit:
        return colors.surfaceContainerHighest;
    }
  }

  Color _baseBorderColor(ColorScheme colors, AppThemePackage package) {
    switch (variant) {
      case SurfaceVariant.standard:
      case SurfaceVariant.subtle:
        return colors.outlineVariant;
      case SurfaceVariant.inset:
        return colors.outline.withValues(alpha: 0.8);
      case SurfaceVariant.lit:
        return package.accentDeep;
    }
  }

  Color _hoveredBackground(ColorScheme colors) {
    return Color.lerp(_baseBackground(colors), colors.primary, 0.03) ??
        _baseBackground(colors);
  }

  Color _hoveredBorder(ColorScheme colors, AppThemePackage package) {
    return Color.lerp(_baseBorderColor(colors, package), colors.primary, 0.4) ??
        _baseBorderColor(colors, package);
  }

  @override
  State<Surface> createState() => _SurfaceState();
}

class _SurfaceState extends State<Surface> {
  bool _isHovered = false;

  void _setHover(bool value) {
    if (!widget._isInteractive || !mounted) return;
    setState(() => _isHovered = value);
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final package =
        Theme.of(context).extension<AppThemePalette>()?.package ??
        AppThemePackages.bundled.first;
    final Color backgroundColor = _isHovered && widget._isInteractive
        ? widget._hoveredBackground(colors)
        : widget._baseBackground(colors);
    final Color borderColor = _isHovered && widget._isInteractive
        ? widget._hoveredBorder(colors, package)
        : widget._baseBorderColor(colors, package);

    final decoration = BoxDecoration(
      color: backgroundColor,
      border: Border.all(color: borderColor, width: 1),
      borderRadius: widget.borderRadius,
    );

    final content = AnimatedContainer(
      duration: AppMotion.fast,
      width: widget.width,
      height: widget.height,
      alignment: widget.alignment,
      margin: widget.margin,
      padding: widget.padding,
      decoration: decoration,
      child: widget.child,
    );

    if (!widget._isInteractive) return content;

    return MouseRegion(
      onEnter: (_) => _setHover(true),
      onExit: (_) => _setHover(false),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: widget.onTap,
          borderRadius: widget.borderRadius,
          mouseCursor: SystemMouseCursors.click,
          overlayColor: WidgetStatePropertyAll(
            colors.primary.withValues(alpha: 0.12),
          ),
          child: content,
        ),
      ),
    );
  }
}
