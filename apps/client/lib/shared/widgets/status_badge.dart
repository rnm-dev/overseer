import 'package:flutter/material.dart';

import 'package:overseer_mobile/shared/design/colors.dart';
import 'package:overseer_mobile/shared/design/typography.dart';

enum StatusBadgeTone { neutral, success, warning, danger }

class StatusBadge extends StatelessWidget {
  const StatusBadge({
    super.key,
    required this.label,
    this.tone = StatusBadgeTone.neutral,
  });

  final String label;
  final StatusBadgeTone tone;

  @override
  Widget build(BuildContext context) {
    final palette = _palette(context);

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
      decoration: BoxDecoration(
        color: palette.fill,
        border: Border.all(color: palette.border),
        borderRadius: BorderRadius.circular(5),
      ),
      child: Text(
        label.toUpperCase(),
        style: AppTypography.display(
          fontSize: 10,
          fontWeight: FontWeight.w600,
          color: palette.text,
          letterSpacing: 1.2,
        ),
      ),
    );
  }

  _StatusBadgePalette _palette(BuildContext context) {
    final theme = AppThemePalette.of(context);
    return switch (tone) {
      StatusBadgeTone.neutral => _StatusBadgePalette(
        text: theme.inkMuted,
        fill: theme.surfaceHover,
        border: theme.surfaceActive,
      ),
      StatusBadgeTone.success => _StatusBadgePalette(
        text: theme.accentStrong,
        fill: theme.accent.withValues(alpha: 0.13),
        border: theme.accent.withValues(alpha: 0.30),
      ),
      StatusBadgeTone.warning => _StatusBadgePalette(
        text: theme.warningStrong,
        fill: theme.warning.withValues(alpha: 0.10),
        border: theme.warning.withValues(alpha: 0.32),
      ),
      StatusBadgeTone.danger => _StatusBadgePalette(
        text: theme.danger,
        fill: theme.danger.withValues(alpha: 0.10),
        border: theme.danger.withValues(alpha: 0.32),
      ),
    };
  }
}

class _StatusBadgePalette {
  const _StatusBadgePalette({
    required this.text,
    required this.fill,
    required this.border,
  });

  final Color text;
  final Color fill;
  final Color border;
}
