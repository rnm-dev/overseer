import 'package:flutter/material.dart';

import 'package:overseer_mobile/shared/design/colors.dart';

enum UserAvatarSize { xs, sm, md, lg, xl }

@immutable
class UserAvatar extends StatelessWidget {
  const UserAvatar({
    super.key,
    required this.label,
    this.src,
    this.size = UserAvatarSize.md,
    this.decorative = false,
    this.tooltip,
  });

  final String label;
  final String? src;
  final UserAvatarSize size;
  final bool decorative;
  final String? tooltip;

  static const double _diameterXs = 16;
  static const double _diameterSm = 20;
  static const double _diameterMd = 28;
  static const double _diameterLg = 36;
  static const double _diameterXl = 40;

  static const double _fontSizeXs = 9;
  static const double _fontSizeSm = 10;
  static const double _fontSizeMd = 12;
  static const double _fontSizeLg = 14;
  static const double _fontSizeXl = 14;

  double get _diameter => switch (size) {
    UserAvatarSize.xs => _diameterXs,
    UserAvatarSize.sm => _diameterSm,
    UserAvatarSize.md => _diameterMd,
    UserAvatarSize.lg => _diameterLg,
    UserAvatarSize.xl => _diameterXl,
  };

  double get _fontSize => switch (size) {
    UserAvatarSize.xs => _fontSizeXs,
    UserAvatarSize.sm => _fontSizeSm,
    UserAvatarSize.md => _fontSizeMd,
    UserAvatarSize.lg => _fontSizeLg,
    UserAvatarSize.xl => _fontSizeXl,
  };

  String get _initial =>
      label.trim().isEmpty ? "?" : label.trim()[0].toUpperCase();

  @override
  Widget build(BuildContext context) {
    final hasSource = src != null && src!.trim().isNotEmpty;
    Widget avatar = SizedBox(
      width: _diameter,
      height: _diameter,
      child: Stack(
        fit: StackFit.expand,
        children: [
          ClipOval(
            child: hasSource
                ? Image.network(
                    src!,
                    width: double.infinity,
                    height: double.infinity,
                    fit: BoxFit.cover,
                    excludeFromSemantics: true,
                    errorBuilder: (_, _, _) => _fallback(),
                  )
                : _fallback(),
          ),
          IgnorePointer(
            child: DecoratedBox(
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(color: AppColors.iron950),
              ),
            ),
          ),
        ],
      ),
    );

    if (!decorative) {
      avatar = Semantics(label: label, image: true, child: avatar);
    } else {
      avatar = ExcludeSemantics(child: avatar);
    }

    if (!decorative && tooltip != null) {
      avatar = Tooltip(message: tooltip!, child: avatar);
    }

    return SizedBox(width: _diameter, height: _diameter, child: avatar);
  }

  Widget _fallback() {
    return Container(
      alignment: Alignment.center,
      color: AppColors.iron900,
      child: Text(
        _initial,
        maxLines: 1,
        style: TextStyle(
          fontSize: _fontSize,
          fontWeight: FontWeight.w700,
          color: AppColors.bone,
          fontFamily: "monospace",
          height: 1,
        ),
      ),
    );
  }
}
