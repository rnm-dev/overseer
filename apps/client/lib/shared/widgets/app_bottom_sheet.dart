import 'package:flutter/material.dart';

import '../design/motion.dart';
import '../design/typography.dart';
import '../layout/responsive_breakpoints.dart';

Future<T?> showAppBottomSheet<T>({
  required BuildContext context,
  required WidgetBuilder builder,
  bool dismissible = true,
  bool enableDrag = true,
  bool useRootNavigator = true,
}) {
  final disableAnimations = MediaQuery.disableAnimationsOf(context);
  final animationStyle = _appSheetAnimationStyle(context);
  if (MediaQuery.sizeOf(context).width >= ResponsiveBreakpoints.medium) {
    final navigator = Navigator.of(context, rootNavigator: useRootNavigator);
    final capturedThemes = InheritedTheme.capture(
      from: context,
      to: navigator.context,
    );
    return showGeneralDialog<T>(
      context: context,
      useRootNavigator: useRootNavigator,
      barrierDismissible: dismissible,
      barrierLabel: MaterialLocalizations.of(context).modalBarrierDismissLabel,
      barrierColor: Theme.of(context).colorScheme.scrim.withValues(alpha: 0.72),
      transitionDuration: animationStyle.duration ?? Duration.zero,
      transitionBuilder: (context, animation, secondaryAnimation, child) {
        final curved = CurvedAnimation(
          parent: animation,
          curve: animationStyle.curve ?? Curves.linear,
          reverseCurve: animationStyle.reverseCurve ?? Curves.linear,
        );
        return FadeTransition(
          opacity: curved,
          child: ScaleTransition(
            scale: Tween<double>(begin: 0.94, end: 1).animate(curved),
            child: child,
          ),
        );
      },
      pageBuilder: (dialogContext, _, _) => capturedThemes.wrap(
        Dialog(
          backgroundColor: Colors.transparent,
          elevation: 0,
          shadowColor: Colors.transparent,
          surfaceTintColor: Colors.transparent,
          insetPadding: const EdgeInsets.symmetric(
            horizontal: 24,
            vertical: 24,
          ),
          insetAnimationDuration: disableAnimations
              ? Duration.zero
              : const Duration(milliseconds: 100),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: Builder(builder: builder),
          ),
        ),
      ),
    );
  }

  return showModalBottomSheet<T>(
    context: context,
    useRootNavigator: useRootNavigator,
    useSafeArea: true,
    isDismissible: dismissible,
    enableDrag: enableDrag,
    isScrollControlled: true,
    showDragHandle: false,
    backgroundColor: Colors.transparent,
    barrierColor: Theme.of(context).colorScheme.scrim.withValues(alpha: 0.72),
    sheetAnimationStyle: animationStyle,
    builder: builder,
  );
}

AnimationStyle _appSheetAnimationStyle(BuildContext context) {
  return MediaQuery.disableAnimationsOf(context)
      ? const AnimationStyle(
          duration: Duration.zero,
          reverseDuration: Duration.zero,
        )
      : const AnimationStyle(
          duration: AppMotion.panelOpen,
          reverseDuration: AppMotion.panelClose,
          curve: AppMotion.iosQuick,
          reverseCurve: AppMotion.softSettle,
        );
}

class AppBottomSheet extends StatelessWidget {
  const AppBottomSheet({
    super.key,
    required this.children,
    this.title,
    this.trailing,
    this.handleKey,
  });

  final String? title;
  final Widget? trailing;
  final List<Widget> children;
  final Key? handleKey;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final isDesktop =
        MediaQuery.sizeOf(context).width >= ResponsiveBreakpoints.medium;
    return LayoutBuilder(
      builder: (context, constraints) {
        final hasFlexibleChild = children.any((child) => child is Flexible);
        final content = <Widget>[
          if (!isDesktop)
            Center(
              child: Container(
                key: handleKey,
                width: 42,
                height: 5,
                decoration: BoxDecoration(
                  color: colors.outline,
                  borderRadius: const BorderRadius.all(Radius.circular(99)),
                ),
              ),
            ),
          if (title case final title?)
            Padding(
              padding: EdgeInsets.only(top: isDesktop ? 0 : 20, bottom: 14),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      title,
                      key: const Key('app-bottom-sheet-title'),
                      style: AppTypography.sectionTitle(
                        color: colors.onSurface,
                      ),
                    ),
                  ),
                  ?trailing,
                ],
              ),
            ),
        ];

        if (isDesktop &&
            constraints.hasBoundedHeight &&
            children.isNotEmpty &&
            !hasFlexibleChild) {
          content.add(
            Flexible(
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: children,
                ),
              ),
            ),
          );
        } else {
          content.addAll(children);
        }

        return Material(
          color: colors.surfaceContainerHighest,
          clipBehavior: Clip.antiAlias,
          shape: RoundedRectangleBorder(
            borderRadius: isDesktop
                ? const BorderRadius.all(Radius.circular(28))
                : const BorderRadius.vertical(top: Radius.circular(28)),
          ),
          child: SafeArea(
            top: false,
            child: Padding(
              padding: EdgeInsets.fromLTRB(16, isDesktop ? 18 : 10, 16, 18),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: content,
              ),
            ),
          ),
        );
      },
    );
  }
}
