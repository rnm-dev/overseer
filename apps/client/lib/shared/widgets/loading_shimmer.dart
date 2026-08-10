import 'package:flutter/material.dart';

import '../../features/themes/app_theme_package.dart';

({Color base, Color highlight}) _shimmerColors(BuildContext context) {
  final theme = Theme.of(context);
  final package = theme.extension<AppThemePalette>()?.package;
  if (package == null) {
    return (
      base: theme.colorScheme.surfaceContainerHighest,
      highlight: theme.colorScheme.outlineVariant,
    );
  }
  return theme.brightness == Brightness.light
      ? (base: package.surfaceHover, highlight: package.surfaceActive)
      : (base: package.surfaceRaised, highlight: package.surfaceHover);
}

class LoadingShimmer extends StatefulWidget {
  const LoadingShimmer({super.key, required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  State<LoadingShimmer> createState() => _LoadingShimmerState();
}

class _LoadingShimmerState extends State<LoadingShimmer>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  )..repeat();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final shimmer = _shimmerColors(context);
    final reduceMotion =
        MediaQuery.maybeOf(context)?.disableAnimations ?? false;

    return Semantics(
      container: true,
      label: widget.label,
      child: ExcludeSemantics(
        child: RepaintBoundary(
          child: AnimatedBuilder(
            animation: _controller,
            child: widget.child,
            builder: (context, child) {
              final progress = reduceMotion ? 0.5 : _controller.value;
              final position = -1.5 + (progress * 3);
              return ShaderMask(
                blendMode: BlendMode.srcATop,
                shaderCallback: (bounds) => LinearGradient(
                  begin: Alignment(position - 1, 0),
                  end: Alignment(position + 1, 0),
                  colors: [shimmer.base, shimmer.highlight, shimmer.base],
                  stops: const [0.25, 0.5, 0.75],
                ).createShader(bounds),
                child: child,
              );
            },
          ),
        ),
      ),
    );
  }
}

class ShimmerBlock extends StatelessWidget {
  const ShimmerBlock({
    super.key,
    required this.width,
    required this.height,
    this.borderRadius = const BorderRadius.all(Radius.circular(4)),
  });

  final double width;
  final double height;
  final BorderRadius borderRadius;

  @override
  Widget build(BuildContext context) {
    final shimmer = _shimmerColors(context);
    return Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: shimmer.base,
        borderRadius: borderRadius,
      ),
    );
  }
}
