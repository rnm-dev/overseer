import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:overseer_mobile/shared/design/colors.dart';
import 'package:overseer_mobile/shared/design/motion.dart';
import 'package:overseer_mobile/shared/layout/responsive_breakpoints.dart';
import 'package:overseer_mobile/shared/widgets/app_bottom_sheet.dart';

const double _defaultDialogMaxWidth = 640;

Future<T?> showAdaptiveAppDialog<T>({
  required BuildContext context,
  required String title,
  WidgetBuilder? contentBuilder,
  Widget? content,
  bool dismissible = true,
  double maxWidth = _defaultDialogMaxWidth,
  bool useRootNavigator = true,
}) {
  assert(
    content != null || contentBuilder != null,
    "Either content or contentBuilder is required.",
  );

  final isCompact =
      ResponsiveBreakpoints.sizeFor(MediaQuery.sizeOf(context).width) ==
      ResponsiveLayoutSize.compact;
  final reducedMotion = MediaQuery.of(context).disableAnimations;
  final builder = contentBuilder ?? ((_) => content!);

  if (isCompact) {
    return showAppBottomSheet<T>(
      context: context,
      useRootNavigator: useRootNavigator,
      dismissible: dismissible,
      enableDrag: dismissible,
      builder: (context) {
        final insetBottom = MediaQuery.of(context).viewInsets.bottom;
        return AnimatedPadding(
          duration: reducedMotion ? Duration.zero : AppMotion.base,
          curve: AppMotion.softSettle,
          padding: EdgeInsets.only(bottom: insetBottom),
          child: _AdaptiveAppDialogPanel(
            title: title,
            contentBuilder: builder,
            dismissible: dismissible,
            isBottomSheet: true,
          ),
        );
      },
    );
  }

  return showGeneralDialog<T>(
    context: context,
    useRootNavigator: useRootNavigator,
    barrierDismissible: dismissible,
    barrierLabel: MaterialLocalizations.of(context).modalBarrierDismissLabel,
    barrierColor: Colors.black54,
    transitionDuration: reducedMotion ? Duration.zero : AppMotion.panelOpen,
    pageBuilder: (_, _, _) {
      return SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: BoxConstraints(maxWidth: maxWidth),
            child: Dialog(
              insetPadding: const EdgeInsets.all(16),
              shape: const RoundedRectangleBorder(
                borderRadius: BorderRadius.all(Radius.circular(14)),
              ),
              backgroundColor: AppColors.iron900,
              child: _AdaptiveAppDialogPanel(
                title: title,
                contentBuilder: builder,
                dismissible: dismissible,
                isBottomSheet: false,
              ),
            ),
          ),
        ),
      );
    },
    transitionBuilder: (context, animation, _, child) {
      if (reducedMotion) return child;
      final curved = CurvedAnimation(
        parent: animation,
        curve: Curves.easeOutCubic,
      );
      return FadeTransition(
        opacity: curved,
        child: ScaleTransition(
          scale: Tween<double>(begin: 0.96, end: 1).animate(curved),
          child: child,
        ),
      );
    },
  );
}

class _AdaptiveAppDialogPanel extends StatelessWidget {
  const _AdaptiveAppDialogPanel({
    required this.title,
    required this.contentBuilder,
    required this.dismissible,
    required this.isBottomSheet,
  });

  final String title;
  final WidgetBuilder contentBuilder;
  final bool dismissible;
  final bool isBottomSheet;

  @override
  Widget build(BuildContext context) {
    if (isBottomSheet) {
      return AppBottomSheet(
        title: title,
        trailing: dismissible
            ? IconButton(
                icon: const Icon(LucideIcons.x),
                tooltip: MaterialLocalizations.of(context).closeButtonTooltip,
                onPressed: () => Navigator.of(context).pop(),
              )
            : null,
        children: [contentBuilder(context)],
      );
    }

    return Material(
      color: AppColors.iron900,
      child: SafeArea(
        top: false,
        minimum: EdgeInsets.only(
          bottom: isBottomSheet ? MediaQuery.of(context).padding.bottom : 0,
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      title,
                      style:
                          Theme.of(context).textTheme.titleMedium ??
                          const TextStyle(),
                    ),
                  ),
                  if (dismissible)
                    IconButton(
                      icon: const Icon(LucideIcons.x),
                      tooltip: MaterialLocalizations.of(
                        context,
                      ).closeButtonTooltip,
                      onPressed: () => Navigator.of(context).pop(),
                    ),
                ],
              ),
              contentBuilder(context),
            ],
          ),
        ),
      ),
    );
  }
}
