import 'package:flutter/material.dart';

import 'package:overseer_mobile/shared/design/colors.dart';
import 'package:overseer_mobile/shared/design/motion.dart';
import 'package:overseer_mobile/shared/design/typography.dart';

enum AppButtonVariant { primary, secondary, ghost, danger }

enum AppButtonSize { sm, md, lg }

class AppButton extends StatelessWidget {
  const AppButton({
    super.key,
    required this.onPressed,
    required this.child,
    this.variant = AppButtonVariant.primary,
    this.size = AppButtonSize.md,
    this.loading = false,
    this.disabled = false,
    this.fullWidth = false,
    this.leading,
    this.trailing,
    this.tooltip,
    this.padding,
    this.borderRadius,
  });

  final VoidCallback? onPressed;
  final Widget child;
  final AppButtonVariant variant;
  final AppButtonSize size;
  final bool loading;
  final bool disabled;
  final bool fullWidth;
  final Widget? leading;
  final Widget? trailing;
  final String? tooltip;
  final EdgeInsetsGeometry? padding;
  final BorderRadius? borderRadius;

  bool get _enabled => onPressed != null && !loading && !disabled;

  EdgeInsetsGeometry _padding() {
    if (padding != null) return padding!;

    return switch (size) {
      AppButtonSize.sm => const EdgeInsets.symmetric(
        horizontal: 11,
        vertical: 7,
      ),
      AppButtonSize.md => const EdgeInsets.symmetric(
        horizontal: 16,
        vertical: 10,
      ),
      AppButtonSize.lg => const EdgeInsets.symmetric(
        horizontal: 20,
        vertical: 12,
      ),
    };
  }

  double _fontSize() {
    return switch (size) {
      AppButtonSize.sm => 12,
      AppButtonSize.md => 13,
      AppButtonSize.lg => 14,
    };
  }

  ButtonStyle _style() {
    return ButtonStyle(
      padding: WidgetStatePropertyAll(_padding()),
      minimumSize: WidgetStatePropertyAll(
        Size(fullWidth ? double.infinity : 0, _buttonHeight()),
      ),
      shape: WidgetStatePropertyAll(
        RoundedRectangleBorder(
          borderRadius: borderRadius ?? AppMotion.controlShape,
        ),
      ),
      textStyle: WidgetStatePropertyAll(
        AppTypography.body(fontSize: _fontSize(), fontWeight: FontWeight.w600),
      ),
      backgroundColor: WidgetStateProperty.resolveWith((states) {
        final bool isEnabled = !states.contains(WidgetState.disabled);
        if (!isEnabled) {
          return switch (variant) {
            AppButtonVariant.primary => AppColors.fel.withValues(alpha: 0.35),
            AppButtonVariant.secondary => AppColors.iron800.withValues(
              alpha: 0.45,
            ),
            AppButtonVariant.ghost => Colors.transparent,
            AppButtonVariant.danger => AppColors.blood.withValues(alpha: 0.35),
          };
        }

        return switch (variant) {
          AppButtonVariant.primary => AppColors.fel,
          AppButtonVariant.secondary => AppColors.iron800,
          AppButtonVariant.ghost => Colors.transparent,
          AppButtonVariant.danger => AppColors.blood,
        };
      }),
      foregroundColor: WidgetStateProperty.resolveWith((states) {
        final bool isEnabled = !states.contains(WidgetState.disabled);
        if (!isEnabled) {
          return switch (variant) {
            AppButtonVariant.primary => AppColors.felInk.withValues(alpha: 0.5),
            AppButtonVariant.secondary => AppColors.boneDim,
            AppButtonVariant.ghost => AppColors.boneDim,
            AppButtonVariant.danger => AppColors.bone.withValues(alpha: 0.5),
          };
        }

        return switch (variant) {
          AppButtonVariant.primary => AppColors.felInk,
          AppButtonVariant.secondary => AppColors.bone,
          AppButtonVariant.ghost => AppColors.boneDim,
          AppButtonVariant.danger => AppColors.bone,
        };
      }),
      side: WidgetStateProperty.resolveWith((states) {
        final bool isEnabled = !states.contains(WidgetState.disabled);
        return switch (variant) {
          AppButtonVariant.secondary => BorderSide(
            color: isEnabled
                ? AppColors.iron700
                : AppColors.iron700.withValues(alpha: 0.45),
          ),
          AppButtonVariant.danger => BorderSide(
            color: isEnabled
                ? AppColors.rust
                : AppColors.rust.withValues(alpha: 0.45),
          ),
          _ => BorderSide.none,
        };
      }),
      overlayColor: WidgetStateProperty.resolveWith((states) {
        if (!states.contains(WidgetState.pressed) &&
            !states.contains(WidgetState.hovered)) {
          return null;
        }
        return switch (variant) {
          AppButtonVariant.primary => AppColors.felBright.withValues(
            alpha: 0.2,
          ),
          AppButtonVariant.secondary => AppColors.iron700.withValues(
            alpha: 0.25,
          ),
          AppButtonVariant.ghost => AppColors.iron800.withValues(alpha: 0.24),
          AppButtonVariant.danger => AppColors.blood.withValues(alpha: 0.2),
        };
      }),
      mouseCursor: WidgetStatePropertyAll(
        _enabled ? SystemMouseCursors.click : SystemMouseCursors.forbidden,
      ),
    );
  }

  double _buttonHeight() {
    return switch (size) {
      AppButtonSize.sm => 32,
      AppButtonSize.md => 40,
      AppButtonSize.lg => 46,
    };
  }

  Widget _spinner() {
    return SizedBox(
      width: 15,
      height: 15,
      child: CircularProgressIndicator(
        strokeWidth: 2,
        valueColor: AlwaysStoppedAnimation<Color>(_spinnerColor()),
      ),
    );
  }

  Color _spinnerColor() {
    if (!loading) {
      return AppColors.bone;
    }

    return switch (variant) {
      AppButtonVariant.primary => AppColors.felInk,
      AppButtonVariant.secondary => AppColors.felBright,
      AppButtonVariant.ghost => AppColors.boneDim,
      AppButtonVariant.danger => AppColors.bone,
    };
  }

  @override
  Widget build(BuildContext context) {
    final button = TextButton(
      onPressed: _enabled ? onPressed : null,
      style: _style(),
      onHover: null,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          if (loading) _spinner(),
          if (loading) const SizedBox(width: 8),
          ?leading,
          if (leading != null) const SizedBox(width: 8),
          child,
          if (trailing != null) ...[const SizedBox(width: 8), ?trailing],
        ],
      ),
    );

    final Widget maybeWrapped = tooltip == null
        ? button
        : Tooltip(message: tooltip!, preferBelow: false, child: button);

    return _buildWidth(maybeWrapped);
  }

  Widget _buildWidth(Widget button) {
    if (!fullWidth) return button;
    return SizedBox(width: double.infinity, child: button);
  }
}
