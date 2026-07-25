import 'package:flutter/material.dart';
import 'package:overseer_mobile/shared/design/colors.dart';
import 'package:overseer_mobile/shared/design/typography.dart';

@immutable
class _EntityListTileGeometry {
  const _EntityListTileGeometry({
    required this.padding,
    required this.titleSize,
    required this.subtitleSize,
    required this.gap,
  });

  final EdgeInsets padding;
  final double titleSize;
  final double subtitleSize;
  final double gap;
}

class EntityListTile extends StatelessWidget {
  const EntityListTile({
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
    this.dense = false,
    this.maxLines = 2,
    this.semanticsLabel,
    this.semanticsHint,
  }) : assert(maxLines > 0);

  final String title;
  final String? subtitle;
  final Widget? leading;
  final Widget? trailing;
  final Widget? status;
  final bool selected;
  final bool enabled;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final bool dense;
  final int maxLines;
  final String? semanticsLabel;
  final String? semanticsHint;

  _EntityListTileGeometry get _geometry => dense
      ? const _EntityListTileGeometry(
          padding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          titleSize: 13,
          subtitleSize: 11.5,
          gap: 2.0,
        )
      : const _EntityListTileGeometry(
          padding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          titleSize: 14.5,
          subtitleSize: 12,
          gap: 2.5,
        );

  bool get _interactive => (onTap != null || onLongPress != null) && enabled;

  String get _resolvedSemanticsLabel {
    if (semanticsLabel != null) return semanticsLabel!;

    if (subtitle == null || subtitle!.isEmpty) return title;

    return '$title. $subtitle';
  }

  @override
  Widget build(BuildContext context) {
    final geometry = _geometry;
    final Color backgroundColor = selected
        ? AppColors.felDim.withAlpha(78)
        : Colors.transparent;
    final Color borderColor = selected ? AppColors.fel : AppColors.iron800;
    final Color titleColor = enabled
        ? (selected ? AppColors.felBright : AppColors.bone)
        : AppColors.boneFaint;
    final Color subtitleColor = enabled
        ? (selected ? AppColors.boneDim : AppColors.boneDim)
        : AppColors.boneFaint;

    final Widget content = Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: <Widget>[
        if (leading != null) ...<Widget>[leading!, const SizedBox(width: 10)],
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.center,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text(
                title,
                style: AppTypography.body(
                  fontSize: geometry.titleSize,
                  fontWeight: FontWeight.w600,
                  color: titleColor,
                ),
                maxLines: maxLines,
                overflow: TextOverflow.ellipsis,
                softWrap: true,
              ),
              if (subtitle != null && subtitle!.isNotEmpty) ...<Widget>[
                SizedBox(height: geometry.gap),
                Text(
                  subtitle!,
                  style: AppTypography.body(
                    fontSize: geometry.subtitleSize,
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
              if (status != null && trailing != null) const SizedBox(height: 4),
              ?trailing,
            ],
          ),
        ],
      ],
    );

    return Semantics(
      container: true,
      button: _interactive,
      enabled: enabled,
      selected: selected,
      label: _resolvedSemanticsLabel,
      hint: semanticsHint,
      child: Material(
        color: AppColors.iron900,
        borderRadius: const BorderRadius.all(Radius.circular(10)),
        child: InkWell(
          onTap: _interactive ? onTap : null,
          onLongPress: _interactive ? onLongPress : null,
          borderRadius: const BorderRadius.all(Radius.circular(10)),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 140),
            padding: geometry.padding,
            decoration: BoxDecoration(
              color: enabled ? backgroundColor : AppColors.iron950,
              border: Border.all(
                color: enabled ? borderColor : AppColors.iron800,
              ),
              borderRadius: const BorderRadius.all(Radius.circular(10)),
            ),
            child: content,
          ),
        ),
      ),
    );
  }
}
