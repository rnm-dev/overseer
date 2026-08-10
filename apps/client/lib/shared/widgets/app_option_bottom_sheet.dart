import 'package:flutter/material.dart';

import '../../features/themes/app_theme_package.dart';
import '../design/motion.dart';
import 'app_bottom_sheet.dart';

Future<T?> showAppOptionBottomSheet<T>({
  required BuildContext context,
  required WidgetBuilder builder,
}) {
  return showAppBottomSheet<T>(context: context, builder: builder);
}

class AppOptionBottomSheet extends StatelessWidget {
  const AppOptionBottomSheet({
    super.key,
    required this.children,
    this.title,
    this.handleKey,
  });

  final String? title;
  final List<Widget> children;
  final Key? handleKey;

  @override
  Widget build(BuildContext context) {
    return AppBottomSheet(
      title: title,
      handleKey: handleKey,
      children: children,
    );
  }
}

class AppOptionSheetTile extends StatelessWidget {
  const AppOptionSheetTile({
    super.key,
    required this.onTap,
    required this.child,
    this.selected = false,
  });

  final VoidCallback onTap;
  final Widget child;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final palette = theme.extension<AppThemePalette>();
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Material(
        color: selected
            ? theme.highlightColor
            : palette?.optionSurface ??
                  theme.colorScheme.surfaceContainerHighest,
        borderRadius: AppMotion.optionShape,
        child: InkWell(
          onTap: onTap,
          borderRadius: AppMotion.optionShape,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 17),
            child: child,
          ),
        ),
      ),
    );
  }
}
