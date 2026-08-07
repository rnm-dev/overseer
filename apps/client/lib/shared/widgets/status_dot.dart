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
    final palette = _palette(context);

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

  _StatusDotPalette _palette(BuildContext context) {
    final theme = AppThemePalette.of(context);
    return switch (state) {
      StatusDotState.online => _StatusDotPalette(
        color: theme.accentStrong,
        glow: theme.accent,
      ),
      StatusDotState.offline => _StatusDotPalette(color: theme.edgeStrong),
      StatusDotState.busy => _StatusDotPalette(
        color: theme.warning,
        glow: theme.warning,
      ),
      StatusDotState.error => _StatusDotPalette(color: theme.danger),
    };
  }
}

class _StatusDotPalette {
  const _StatusDotPalette({required this.color, this.glow});

  final Color color;
  final Color? glow;
}
