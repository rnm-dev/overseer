import 'package:flutter/material.dart';

import 'package:overseer_mobile/shared/design/colors.dart';

enum StatusDotState { online, offline, busy, error }

class StatusDot extends StatelessWidget {
  const StatusDot({
    super.key,
    required this.state,
    this.semanticLabel,
    this.size = 8,
  });

  final StatusDotState state;
  final String? semanticLabel;
  final double size;

  @override
  Widget build(BuildContext context) {
    final palette = _palette();

    return Semantics(
      label: semanticLabel,
      child: Container(
        width: size,
        height: size,
        margin: const EdgeInsets.all(0),
        decoration: BoxDecoration(
          color: palette.color,
          shape: BoxShape.circle,
          boxShadow: palette.glow == null
              ? null
              : [
                  BoxShadow(
                    color: palette.glow!.withValues(alpha: 0.75),
                    blurRadius: 6,
                    spreadRadius: 1,
                  ),
                ],
        ),
      ),
    );
  }

  _StatusDotPalette _palette() {
    return switch (state) {
      StatusDotState.online => const _StatusDotPalette(
        color: AppColors.felBright,
        glow: AppColors.fel,
      ),
      StatusDotState.offline => const _StatusDotPalette(
        color: AppColors.iron600,
      ),
      StatusDotState.busy => const _StatusDotPalette(
        color: AppColors.forge,
        glow: AppColors.forge,
      ),
      StatusDotState.error => const _StatusDotPalette(color: AppColors.blood),
    };
  }
}

class _StatusDotPalette {
  const _StatusDotPalette({required this.color, this.glow});

  final Color color;
  final Color? glow;
}
