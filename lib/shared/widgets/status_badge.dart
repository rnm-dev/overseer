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
    final palette = _palette();

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

  _StatusBadgePalette _palette() {
    return switch (tone) {
      StatusBadgeTone.neutral => const _StatusBadgePalette(
        text: AppColors.boneDim,
        fill: AppColors.iron800,
        border: AppColors.iron700,
      ),
      StatusBadgeTone.success => const _StatusBadgePalette(
        text: AppColors.felBright,
        fill: Color(0x2086AB63),
        border: Color(0x4D86AB63),
      ),
      StatusBadgeTone.warning => const _StatusBadgePalette(
        text: AppColors.ember,
        fill: Color(0x1AD99441),
        border: Color(0x52D99441),
      ),
      StatusBadgeTone.danger => const _StatusBadgePalette(
        text: AppColors.blood,
        fill: Color(0x1AD95F48),
        border: Color(0x52D95F48),
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
