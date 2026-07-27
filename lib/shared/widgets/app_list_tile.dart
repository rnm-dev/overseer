import 'package:flutter/material.dart';

import 'package:overseer_mobile/shared/design/colors.dart';
import 'package:overseer_mobile/shared/design/motion.dart';
import 'package:overseer_mobile/shared/design/typography.dart';

enum AppListTileDensity { compact, standard }

enum AppListTileVariant { standalone, sectionSurface }

/// The shared interactive row for navigation, settings, and entity lists.
///
/// Feature widgets provide meaning through their content and semantics while
/// this primitive owns geometry, states, touch targets, and interaction color.
class AppListTile extends StatelessWidget {
  const AppListTile({
    super.key,
    required this.title,
    this.subtitle,
    this.leading,
    this.trailing,
    this.status,
    this.selected = false,
    this.enabled = true,
    this.onTap,
    this.onLongPress,
    this.density = AppListTileDensity.standard,
    this.variant = AppListTileVariant.standalone,
    this.titleMaxLines = 2,
    this.semanticsLabel,
    this.semanticsHint,
  }) : assert(titleMaxLines > 0);

  final String title;
  final String? subtitle;
  final Widget? leading;
  final Widget? trailing;
  final Widget? status;
  final bool selected;
  final bool enabled;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final AppListTileDensity density;
  final AppListTileVariant variant;
  final int titleMaxLines;
  final String? semanticsLabel;
  final String? semanticsHint;

  bool get _interactive => (onTap != null || onLongPress != null) && enabled;

  EdgeInsets get _padding => switch (density) {
    AppListTileDensity.compact => const EdgeInsets.symmetric(
      horizontal: 12,
      vertical: 9,
    ),
    AppListTileDensity.standard => const EdgeInsets.symmetric(
      horizontal: 14,
      vertical: 11,
    ),
  };

  double get _minimumHeight => switch (density) {
    AppListTileDensity.compact => 44,
    AppListTileDensity.standard => 56,
  };

  double get _titleSize => switch (density) {
    AppListTileDensity.compact => 13,
    AppListTileDensity.standard => 15,
  };

  double get _subtitleSize => switch (density) {
    AppListTileDensity.compact => 11.5,
    AppListTileDensity.standard => 12,
  };

  double get _textGap => switch (density) {
    AppListTileDensity.compact => 2,
    AppListTileDensity.standard => 2.5,
  };

  @override
  Widget build(BuildContext context) {
    final sectionSurface = variant == AppListTileVariant.sectionSurface;
    final shape = sectionSurface ? BorderRadius.zero : AppMotion.listTileShape;
    final backgroundColor = selected
        ? AppColors.felDim.withAlpha(78)
        : Colors.transparent;
    final surfaceColor = sectionSurface
        ? AppColors.bone.withValues(alpha: 0.05)
        : AppColors.rowSurface;
    final borderColor = selected
        ? AppColors.fel
        : sectionSurface
        ? Colors.transparent
        : AppColors.iron800;
    final titleColor = enabled
        ? (selected ? AppColors.felBright : AppColors.bone)
        : AppColors.boneFaint;
    final subtitleColor = enabled ? AppColors.boneDim : AppColors.boneFaint;

    return Semantics(
      container: true,
      button: _interactive,
      enabled: enabled,
      selected: selected,
      label: semanticsLabel,
      hint: semanticsHint,
      excludeSemantics: semanticsLabel != null,
      child: Material(
        color: enabled ? surfaceColor : AppColors.iron950,
        borderRadius: shape,
        child: InkWell(
          onTap: _interactive ? onTap : null,
          onLongPress: _interactive ? onLongPress : null,
          borderRadius: shape,
          overlayColor: WidgetStatePropertyAll(
            AppColors.fel.withValues(alpha: 0.1),
          ),
          child: AnimatedContainer(
            duration: AppMotion.fast,
            constraints: BoxConstraints(minHeight: _minimumHeight),
            padding: _padding,
            decoration: BoxDecoration(
              color: enabled ? backgroundColor : AppColors.iron950,
              border: Border.all(
                color: enabled ? borderColor : AppColors.iron800,
                width: sectionSurface ? 0 : 0.75,
              ),
              borderRadius: shape,
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: <Widget>[
                if (leading != null) ...<Widget>[
                  leading!,
                  const SizedBox(width: 10),
                ],
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.center,
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Text(
                        title,
                        style: AppTypography.body(
                          fontSize: _titleSize,
                          fontWeight: FontWeight.w600,
                          color: titleColor,
                        ),
                        maxLines: titleMaxLines,
                        overflow: TextOverflow.ellipsis,
                        softWrap: true,
                      ),
                      if (subtitle != null && subtitle!.isNotEmpty) ...<Widget>[
                        SizedBox(height: _textGap),
                        Text(
                          subtitle!,
                          style: AppTypography.body(
                            fontSize: _subtitleSize,
                            color: subtitleColor,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          softWrap: true,
                        ),
                      ],
                    ],
                  ),
                ),
                if (status != null || trailing != null) ...<Widget>[
                  const SizedBox(width: 10),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    mainAxisAlignment: MainAxisAlignment.center,
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      ?status,
                      if (status != null && trailing != null)
                        const SizedBox(height: 4),
                      ?trailing,
                    ],
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
