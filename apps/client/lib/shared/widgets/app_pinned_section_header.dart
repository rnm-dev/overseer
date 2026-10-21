import 'dart:ui';

import 'package:flutter/material.dart';

/// Fixed-height sliver header that stays pinned and blurs content behind it.
class AppPinnedSectionHeader extends StatelessWidget {
  const AppPinnedSectionHeader({
    super.key,
    required this.child,
    this.blurKey = const Key('pinned-section-header-blur'),
    this.extent = defaultExtent,
  });

  static const double defaultExtent = 28;
  static const double blurSigma = 12;

  final Widget child;
  final Key blurKey;
  final double extent;

  @override
  Widget build(BuildContext context) {
    return SliverPersistentHeader(
      pinned: true,
      delegate: _AppPinnedSectionHeaderDelegate(
        child: child,
        blurKey: blurKey,
        extent: extent,
      ),
    );
  }
}

class _AppPinnedSectionHeaderDelegate extends SliverPersistentHeaderDelegate {
  const _AppPinnedSectionHeaderDelegate({
    required this.child,
    required this.blurKey,
    required this.extent,
  });

  final Widget child;
  final Key blurKey;
  final double extent;

  @override
  double get minExtent => extent;

  @override
  double get maxExtent => extent;

  @override
  Widget build(
    BuildContext context,
    double shrinkOffset,
    bool overlapsContent,
  ) {
    return ClipRect(
      child: BackdropFilter(
        key: blurKey,
        filter: ImageFilter.blur(
          sigmaX: AppPinnedSectionHeader.blurSigma,
          sigmaY: AppPinnedSectionHeader.blurSigma,
        ),
        child: SizedBox.expand(child: child),
      ),
    );
  }

  @override
  bool shouldRebuild(_AppPinnedSectionHeaderDelegate oldDelegate) {
    return oldDelegate.child != child ||
        oldDelegate.blurKey != blurKey ||
        oldDelegate.extent != extent;
  }
}
