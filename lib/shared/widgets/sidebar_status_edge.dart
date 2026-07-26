import 'package:flutter/material.dart';

import '../design/colors.dart';

@immutable
class SidebarStatusEdgeStyle {
  const SidebarStatusEdgeStyle({required this.color, this.glowColor});

  static const idle = SidebarStatusEdgeStyle(color: Color(0x6664685A));

  static const running = SidebarStatusEdgeStyle(
    color: AppColors.felBright,
    glowColor: AppColors.fel,
  );

  static const attention = SidebarStatusEdgeStyle(
    color: AppColors.forge,
    glowColor: AppColors.forge,
  );

  static const failure = SidebarStatusEdgeStyle(
    color: AppColors.blood,
    glowColor: AppColors.blood,
  );

  final Color color;
  final Color? glowColor;
}

class SidebarStatusEdge extends StatefulWidget {
  const SidebarStatusEdge({
    super.key,
    required this.style,
    required this.semanticLabel,
    this.flashRevision = 0,
  });

  final SidebarStatusEdgeStyle style;
  final String semanticLabel;
  final int flashRevision;

  @override
  State<SidebarStatusEdge> createState() => _SidebarStatusEdgeState();
}

class _SidebarStatusEdgeState extends State<SidebarStatusEdge>
    with SingleTickerProviderStateMixin {
  static const _flashDuration = Duration(milliseconds: 620);

  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: _flashDuration,
    value: widget.flashRevision > 0 ? 0 : 1,
  );
  bool _startedInitialFlash = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_startedInitialFlash || widget.flashRevision == 0) return;
    _startedInitialFlash = true;
    if (MediaQuery.maybeOf(context)?.disableAnimations ?? false) {
      _controller.value = 1;
    } else {
      _controller.forward();
    }
  }

  @override
  void didUpdateWidget(covariant SidebarStatusEdge oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.flashRevision == 0 ||
        widget.flashRevision == oldWidget.flashRevision) {
      return;
    }
    if (MediaQuery.maybeOf(context)?.disableAnimations ?? false) {
      _controller.value = 1;
    } else {
      _controller.forward(from: 0);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: widget.semanticLabel,
      child: ExcludeSemantics(
        child: AnimatedBuilder(
          animation: _controller,
          builder: (context, _) {
            final flare = _flareAt(_controller.value);
            return ColorFiltered(
              colorFilter: ColorFilter.matrix(_filterMatrix(flare)),
              child: Container(
                width: 2,
                decoration: BoxDecoration(
                  color: widget.style.color,
                  boxShadow: _shadows(flare),
                ),
              ),
            );
          },
        ),
      ),
    );
  }

  double _flareAt(double value) {
    if (value >= 1) return 0;
    if (value <= 0.14) {
      return Curves.easeOut.transform(value / 0.14);
    }
    return 1 - Curves.easeOut.transform((value - 0.14) / 0.86);
  }

  List<BoxShadow>? _shadows(double flare) {
    final glowColor = widget.style.glowColor;
    if (flare > 0) {
      final flareColor = glowColor ?? AppColors.fel;
      final startsGlowing = glowColor != null;
      return [
        BoxShadow(
          color: flareColor.withValues(alpha: startsGlowing ? 1 : flare),
          blurRadius: startsGlowing ? 5 + (4 * flare) : 9 * flare,
        ),
        BoxShadow(
          color: flareColor.withValues(
            alpha: startsGlowing ? 0.78 + (0.22 * flare) : flare,
          ),
          blurRadius: startsGlowing ? 15 + (11 * flare) : 26 * flare,
        ),
        BoxShadow(
          color: flareColor.withValues(alpha: 0.45 * flare),
          blurRadius: 46 * flare,
        ),
      ];
    }
    if (glowColor == null) return null;
    return [
      BoxShadow(color: glowColor, blurRadius: 5),
      BoxShadow(color: glowColor.withValues(alpha: 0.78), blurRadius: 15),
    ];
  }

  List<double> _filterMatrix(double flare) {
    final brightness = 1 + (1.3 * flare);
    final saturation = 1 + (0.3 * flare);
    final inverse = 1 - saturation;
    const redLuminance = 0.2126;
    const greenLuminance = 0.7152;
    const blueLuminance = 0.0722;
    return [
      (redLuminance * inverse + saturation) * brightness,
      (greenLuminance * inverse) * brightness,
      (blueLuminance * inverse) * brightness,
      0,
      0,
      (redLuminance * inverse) * brightness,
      (greenLuminance * inverse + saturation) * brightness,
      (blueLuminance * inverse) * brightness,
      0,
      0,
      (redLuminance * inverse) * brightness,
      (greenLuminance * inverse) * brightness,
      (blueLuminance * inverse + saturation) * brightness,
      0,
      0,
      0,
      0,
      0,
      1,
      0,
    ];
  }
}
