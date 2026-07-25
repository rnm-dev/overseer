import 'package:flutter/material.dart';
import 'package:overseer_mobile/shared/design/colors.dart';
import 'package:overseer_mobile/shared/widgets/overseer_logo.dart';

/// Continues the branded launch surface while app state is restored.
class AppRestoringPage extends StatelessWidget {
  const AppRestoringPage({super.key});

  static const double logoExtent = OverseerLogo.splashExtent;
  static const double progressOffset = 112;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Semantics(
        container: true,
        label: 'Restoring session',
        child: Stack(
          fit: StackFit.expand,
          children: [
            Center(child: const OverseerLogo(key: Key('auth-restoring-logo'))),
            Center(
              child: Transform.translate(
                offset: const Offset(0, progressOffset),
                child: const _GlowingProgressBar(
                  key: Key('auth-restoring-progress'),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _GlowingProgressBar extends StatefulWidget {
  const _GlowingProgressBar({super.key});

  @override
  State<_GlowingProgressBar> createState() => _GlowingProgressBarState();
}

class _GlowingProgressBarState extends State<_GlowingProgressBar>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1400),
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Loading',
      child: SizedBox(
        width: 104,
        height: 12,
        child: CustomPaint(
          painter: _GlowingProgressPainter(animation: _controller),
        ),
      ),
    );
  }
}

class _GlowingProgressPainter extends CustomPainter {
  _GlowingProgressPainter({required this.animation})
    : super(repaint: animation);

  static const double _lineHeight = 2;
  static const double _streakWidth = 38;

  final Animation<double> animation;

  @override
  void paint(Canvas canvas, Size size) {
    final centerY = size.height / 2;
    final track = RRect.fromRectAndRadius(
      Rect.fromLTWH(0, centerY - (_lineHeight / 2), size.width, _lineHeight),
      const Radius.circular(_lineHeight / 2),
    );
    canvas.drawRRect(
      track,
      Paint()..color = AppColors.fel.withValues(alpha: 0.18),
    );

    canvas.save();
    canvas.clipRect(Offset.zero & size);

    final streakLeft =
        (size.width + _streakWidth) * animation.value - _streakWidth;
    final streakRect = Rect.fromLTWH(
      streakLeft,
      centerY - (_lineHeight / 2),
      _streakWidth,
      _lineHeight,
    );
    final shader = const LinearGradient(
      colors: [Colors.transparent, AppColors.felBright, Colors.transparent],
      stops: [0, 0.5, 1],
    ).createShader(streakRect);

    canvas.drawRRect(
      RRect.fromRectAndRadius(streakRect, const Radius.circular(1)),
      Paint()
        ..shader = shader
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 4),
    );
    canvas.drawRRect(
      RRect.fromRectAndRadius(streakRect, const Radius.circular(1)),
      Paint()..shader = shader,
    );
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _GlowingProgressPainter oldDelegate) => false;
}
