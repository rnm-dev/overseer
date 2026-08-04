import 'package:flutter/material.dart';

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
        horizontal: 12,
        vertical: 8,
      ),
      AppButtonSize.md => const EdgeInsets.symmetric(
        horizontal: 16,
        vertical: 11,
      ),
      AppButtonSize.lg => const EdgeInsets.symmetric(
        horizontal: 20,
        vertical: 13,
      ),
    };
  }

  double _fontSize() {
    return switch (size) {
      AppButtonSize.sm => 12,
      AppButtonSize.md => 14,
      AppButtonSize.lg => 15,
    };
  }

  ButtonStyle _style(ColorScheme colors) {
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
            AppButtonVariant.primary => colors.primary.withValues(alpha: 0.35),
            AppButtonVariant.secondary =>
              colors.surfaceContainerHighest.withValues(alpha: 0.45),
            AppButtonVariant.ghost => Colors.transparent,
            AppButtonVariant.danger => colors.error.withValues(alpha: 0.35),
          };
        }

        return switch (variant) {
          AppButtonVariant.primary => colors.primary,
          AppButtonVariant.secondary => colors.surfaceContainerHighest,
          AppButtonVariant.ghost => Colors.transparent,
          AppButtonVariant.danger => colors.error,
        };
      }),
      foregroundColor: WidgetStateProperty.resolveWith((states) {
        final bool isEnabled = !states.contains(WidgetState.disabled);
        if (!isEnabled) {
          return switch (variant) {
            AppButtonVariant.primary => colors.onPrimary.withValues(alpha: 0.5),
            AppButtonVariant.secondary => colors.onSurfaceVariant,
            AppButtonVariant.ghost => colors.onSurfaceVariant,
            AppButtonVariant.danger => colors.onError.withValues(alpha: 0.5),
          };
        }

        return switch (variant) {
          AppButtonVariant.primary => colors.onPrimary,
          AppButtonVariant.secondary => colors.onSurface,
          AppButtonVariant.ghost => colors.onSurfaceVariant,
          AppButtonVariant.danger => colors.onError,
        };
      }),
      side: WidgetStateProperty.resolveWith((states) {
        final bool isEnabled = !states.contains(WidgetState.disabled);
        return switch (variant) {
          AppButtonVariant.secondary => BorderSide(
            color: isEnabled
                ? colors.outline
                : colors.outlineVariant.withValues(alpha: 0.45),
          ),
          AppButtonVariant.danger => BorderSide(
            color: isEnabled
                ? colors.errorContainer
                : colors.errorContainer.withValues(alpha: 0.45),
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
          AppButtonVariant.primary => colors.primary.withValues(alpha: 0.2),
          AppButtonVariant.secondary => colors.outlineVariant.withValues(
            alpha: 0.25,
          ),
          AppButtonVariant.ghost => colors.outlineVariant.withValues(
            alpha: 0.24,
          ),
          AppButtonVariant.danger => colors.error.withValues(alpha: 0.2),
        };
      }),
      mouseCursor: WidgetStatePropertyAll(
        _enabled ? SystemMouseCursors.click : SystemMouseCursors.forbidden,
      ),
    );
  }

  double _buttonHeight() {
    return switch (size) {
      AppButtonSize.sm => 36,
      AppButtonSize.md => 44,
      AppButtonSize.lg => 50,
    };
  }

  Widget _spinner(ColorScheme colors) {
    return SizedBox(
      width: 15,
      height: 15,
      child: CircularProgressIndicator(
        strokeWidth: 2,
        valueColor: AlwaysStoppedAnimation<Color>(_spinnerColor(colors)),
      ),
    );
  }

  Color _spinnerColor(ColorScheme colors) {
    if (!loading) {
      return colors.onSurface;
    }

    return switch (variant) {
      AppButtonVariant.primary => colors.onPrimary,
      AppButtonVariant.secondary => colors.primary,
      AppButtonVariant.ghost => colors.onSurfaceVariant,
      AppButtonVariant.danger => colors.onError,
    };
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final button = TextButton(
      onPressed: _enabled ? onPressed : null,
      style: _style(colors),
      onHover: null,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          if (loading) _spinner(colors),
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
