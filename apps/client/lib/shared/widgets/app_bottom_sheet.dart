import 'package:flutter/material.dart';

import '../design/motion.dart';
import '../design/typography.dart';

Future<T?> showAppBottomSheet<T>({
  required BuildContext context,
  required WidgetBuilder builder,
  bool dismissible = true,
  bool enableDrag = true,
  bool useRootNavigator = true,
}) {
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
    sheetAnimationStyle: MediaQuery.disableAnimationsOf(context)
        ? const AnimationStyle(
            duration: Duration.zero,
            reverseDuration: Duration.zero,
          )
        : const AnimationStyle(
            duration: AppMotion.panelOpen,
            reverseDuration: AppMotion.panelClose,
            curve: AppMotion.iosQuick,
            reverseCurve: AppMotion.softSettle,
          ),
    builder: builder,
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
    return Material(
      color: colors.surfaceContainerHighest,
      clipBehavior: Clip.antiAlias,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 18),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
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
                  padding: const EdgeInsets.only(top: 20, bottom: 14),
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
              ...children,
            ],
          ),
        ),
      ),
    );
  }
}
