import 'package:flutter/material.dart';

import 'package:overseer_mobile/shared/widgets/app_list_tile.dart';

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

  @override
  Widget build(BuildContext context) {
    return AppListTile(
      title: title,
      subtitle: subtitle,
      leading: leading,
      trailing: trailing,
      status: status,
      selected: selected,
      enabled: enabled,
      onTap: onTap,
      onLongPress: onLongPress,
      density: dense ? AppListTileDensity.compact : AppListTileDensity.standard,
      titleMaxLines: maxLines,
      semanticsLabel: semanticsLabel,
      semanticsHint: semanticsHint,
    );
  }
}
