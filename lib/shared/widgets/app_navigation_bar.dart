import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../design/colors.dart';

class AppNavigationBar extends StatelessWidget {
  const AppNavigationBar({
    super.key,
    this.left,
    this.right,
    this.showBackButton = false,
    this.onBack,
    this.backButtonKey,
    this.backTooltip = 'Back',
    this.applyTopSafeArea = true,
    this.topInsetReduction = 0,
    this.contentHeight = 44,
    this.contentPadding = const EdgeInsets.fromLTRB(8, 2, 12, 2),
  }) : assert(topInsetReduction >= 0),
       assert(contentHeight > 0);

  final Widget? left;
  final Widget? right;
  final bool showBackButton;
  final VoidCallback? onBack;
  final Key? backButtonKey;
  final String backTooltip;
  final bool applyTopSafeArea;
  final double topInsetReduction;
  final double contentHeight;
  final EdgeInsetsGeometry contentPadding;

  @override
  Widget build(BuildContext context) {
    final topInset = applyTopSafeArea
        ? math.max(0.0, MediaQuery.paddingOf(context).top - topInsetReduction)
        : 0.0;

    return DecoratedBox(
      decoration: const BoxDecoration(
        border: Border(
          bottom: BorderSide(color: AppColors.iron800, width: 0.5),
        ),
      ),
      child: Padding(
        padding: EdgeInsets.only(top: topInset),
        child: SizedBox(
          height: contentHeight,
          child: Padding(
            padding: contentPadding,
            child: Row(
              children: [
                if (showBackButton) ...[
                  IconButton(
                    key: backButtonKey,
                    tooltip: backTooltip,
                    onPressed: onBack ?? () => Navigator.of(context).maybePop(),
                    padding: EdgeInsets.zero,
                    constraints: const BoxConstraints.tightFor(
                      width: 36,
                      height: 40,
                    ),
                    style: IconButton.styleFrom(
                      minimumSize: const Size(36, 40),
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                    icon: const Icon(
                      LucideIcons.arrowLeft,
                      size: 18,
                      color: AppColors.boneDim,
                    ),
                  ),
                  const SizedBox(width: 4),
                ],
                Expanded(child: left ?? const SizedBox.shrink()),
                ?right,
              ],
            ),
          ),
        ),
      ),
    );
  }
}
