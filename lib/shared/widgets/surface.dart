import 'package:flutter/material.dart';

import 'package:overseer_mobile/shared/design/colors.dart';
import 'package:overseer_mobile/shared/design/motion.dart';

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

  Color _baseBackground() {
    switch (variant) {
      case SurfaceVariant.standard:
        return AppColors.iron900;
      case SurfaceVariant.subtle:
        return AppColors.iron900.withValues(alpha: 0.6);
      case SurfaceVariant.inset:
        return AppColors.iron950.withValues(alpha: 0.58);
      case SurfaceVariant.lit:
        return AppColors.iron900;
    }
  }

  Color _baseBorderColor() {
    switch (variant) {
      case SurfaceVariant.standard:
      case SurfaceVariant.subtle:
        return AppColors.iron800;
      case SurfaceVariant.inset:
        return AppColors.iron700.withValues(alpha: 0.8);
      case SurfaceVariant.lit:
        return AppColors.felDeep;
    }
  }

  Color _hoveredBackground() {
    return Color.lerp(_baseBackground(), AppColors.fel, 0.03) ??
        _baseBackground();
  }

  Color _hoveredBorder() {
    return Color.lerp(_baseBorderColor(), AppColors.fel, 0.4) ??
        _baseBorderColor();
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
    final Color backgroundColor = _isHovered && widget._isInteractive
        ? widget._hoveredBackground()
        : widget._baseBackground();
    final Color borderColor = _isHovered && widget._isInteractive
        ? widget._hoveredBorder()
        : widget._baseBorderColor();

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
            AppColors.fel.withValues(alpha: 0.12),
          ),
          child: content,
        ),
      ),
    );
  }
}
