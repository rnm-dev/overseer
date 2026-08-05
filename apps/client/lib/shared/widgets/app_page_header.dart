import 'package:flutter/material.dart';

import 'package:overseer_mobile/shared/design/typography.dart';

/// Shared introductory hierarchy for focused setup and authentication pages.
class AppPageHeader extends StatelessWidget {
  const AppPageHeader({
    super.key,
    required this.title,
    this.subtitle,
    this.textAlign = TextAlign.center,
  });

  final String title;
  final String? subtitle;
  final TextAlign textAlign;

  CrossAxisAlignment get _crossAxisAlignment => textAlign == TextAlign.center
      ? CrossAxisAlignment.center
      : CrossAxisAlignment.start;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: _crossAxisAlignment,
      children: [
        Text(title, textAlign: textAlign, style: AppTypography.pageTitle()),
        if (subtitle != null && subtitle!.isNotEmpty) ...[
          const SizedBox(height: 8),
          Text(
            subtitle!,
            textAlign: textAlign,
            style: AppTypography.body(
              fontSize: 14,
              color: Theme.of(context).colorScheme.onSurfaceVariant,
              height: 1.45,
            ),
          ),
        ],
      ],
    );
  }
}
