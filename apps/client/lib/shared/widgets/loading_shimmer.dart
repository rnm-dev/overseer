import 'package:flutter/material.dart';

import '../design/colors.dart';

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
                  colors: const [
                    AppColors.iron800,
                    AppColors.iron700,
                    AppColors.iron800,
                  ],
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
    return Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: AppColors.iron800,
        borderRadius: borderRadius,
      ),
    );
  }
}
