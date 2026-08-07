import 'package:flutter/material.dart';

import 'package:overseer_mobile/shared/design/colors.dart';
import 'package:overseer_mobile/shared/design/motion.dart';
import 'package:overseer_mobile/shared/widgets/user_avatar.dart';

@immutable
class PresencePerson {
  const PresencePerson({
    required this.userId,
    required this.displayName,
    this.avatarUrl,
  });

  final String userId;
  final String displayName;
  final String? avatarUrl;
}

enum PresenceStackSize { xs, sm, md }

@immutable
class PresenceStack extends StatefulWidget {
  const PresenceStack({
    super.key,
    required this.viewers,
    this.size = PresenceStackSize.sm,
    this.softShadow = false,
  });

  static const int maxVisible = 3;
  static const double _overlap = 6;

  final List<PresencePerson> viewers;
  final PresenceStackSize size;
  final bool softShadow;

  @override
  State<PresenceStack> createState() => _PresenceStackState();
}

class _PresenceStackState extends State<PresenceStack> {
  UserAvatarSize _avatarSize() => switch (widget.size) {
    PresenceStackSize.xs => UserAvatarSize.xs,
    PresenceStackSize.sm => UserAvatarSize.sm,
    PresenceStackSize.md => UserAvatarSize.md,
  };

  @override
  Widget build(BuildContext context) {
    final visible = widget.viewers.take(PresenceStack.maxVisible).toList();
    final overflow = widget.viewers.length - PresenceStack.maxVisible;
    final overflowNames = widget.viewers
        .skip(PresenceStack.maxVisible)
        .map((person) => person.displayName)
        .join(", ");
    final allNames = widget.viewers
        .map((person) => person.displayName)
        .join(", ");
    final avatarSize = _avatarSize();
    final diameter = _diameter(avatarSize);
    final itemCount = visible.length + (overflow > 0 ? 1 : 0);
    final stackWidth = itemCount == 0
        ? 0.0
        : diameter + ((itemCount - 1) * (diameter - PresenceStack._overlap));
    final duration = MediaQuery.disableAnimationsOf(context)
        ? Duration.zero
        : AppMotion.base;
    final items = <Widget>[
      for (final person in visible)
        Tooltip(
          key: ValueKey('presence-${person.userId}'),
          message: person.displayName,
          child: _ringed(
            UserAvatar(
              label: person.displayName,
              src: person.avatarUrl,
              size: avatarSize,
              decorative: true,
            ),
          ),
        ),
      if (overflow > 0)
        Tooltip(
          key: ValueKey('presence-overflow-$overflow-$overflowNames'),
          message: overflowNames,
          child: _overflowBadge(count: overflow),
        ),
    ];

    return Semantics(
      container: true,
      label: widget.viewers.isEmpty ? null : "Online viewers: $allNames",
      child: AnimatedContainer(
        key: const Key('presence-stack-frame'),
        duration: duration,
        curve: AppMotion.iosQuick,
        width: stackWidth,
        height: itemCount == 0 ? 0 : diameter,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            for (var index = 0; index < PresenceStack.maxVisible + 1; index++)
              Positioned(
                left: index * (diameter - PresenceStack._overlap),
                child: AnimatedSwitcher(
                  key: Key('presence-slot-$index'),
                  duration: duration,
                  reverseDuration: duration,
                  switchInCurve: AppMotion.iosQuick,
                  switchOutCurve: Curves.easeIn,
                  transitionBuilder: (child, animation) {
                    return FadeTransition(
                      opacity: animation,
                      child: ScaleTransition(
                        scale: Tween<double>(
                          begin: 0.72,
                          end: 1,
                        ).animate(animation),
                        child: child,
                      ),
                    );
                  },
                  child: index < items.length
                      ? items[index]
                      : SizedBox.square(
                          key: ValueKey('presence-empty-$index'),
                          dimension: diameter,
                        ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _ringed(Widget child) {
    return DecoratedBox(
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        boxShadow: [
          if (widget.softShadow)
            BoxShadow(
              color: Theme.of(
                context,
              ).colorScheme.shadow.withValues(alpha: 0.28),
              blurRadius: 18,
              spreadRadius: 5,
              offset: const Offset(0, 3),
            ),
          BoxShadow(
            color: AppThemePalette.of(context).accent.withValues(alpha: 0.5),
            blurRadius: 0,
            spreadRadius: 1,
          ),
        ],
      ),
      child: child,
    );
  }

  Widget _overflowBadge({required int count}) {
    return _ringed(
      Container(
        width: _diameter(_avatarSize()),
        height: _diameter(_avatarSize()),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: AppThemePalette.of(context).surfaceHover,
          border: Border.all(color: AppThemePalette.of(context).surface),
        ),
        child: Text(
          "+$count",
          style: TextStyle(
            fontSize: switch (widget.size) {
              PresenceStackSize.xs => 8,
              PresenceStackSize.sm => 9,
              PresenceStackSize.md => 10,
            },
            fontWeight: FontWeight.w600,
            color: AppThemePalette.of(context).inkMuted,
            height: 1,
          ),
        ),
      ),
    );
  }

  double _diameter(UserAvatarSize avatarSize) => switch (avatarSize) {
    UserAvatarSize.xs => 16,
    UserAvatarSize.sm => 20,
    UserAvatarSize.md => 28,
    UserAvatarSize.lg => 36,
    UserAvatarSize.xl => 40,
  };
}
