import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:overseer_mobile/shared/design/motion.dart';
import 'package:overseer_mobile/shared/design/typography.dart';

class AppTextField extends StatelessWidget {
  const AppTextField({
    super.key,
    this.controller,
    this.focusNode,
    this.label,
    this.hint,
    this.helperText,
    this.errorText,
    this.prefix,
    this.suffix,
    this.mono = false,
    this.enabled = true,
    this.readOnly = false,
    this.obscureText = false,
    this.keyboardType = TextInputType.text,
    this.textInputAction = TextInputAction.done,
    this.textAlign = TextAlign.start,
    this.minLines,
    this.maxLines = 1,
    this.maxLength,
    this.onChanged,
    this.onSubmitted,
    this.onTap,
    this.autofocus = false,
    this.autocorrect = true,
    this.smartDashesType,
    this.smartQuotesType,
    this.textCapitalization = TextCapitalization.none,
    this.scrollPadding = const EdgeInsets.all(20),
    this.inputFormatters,
  });

  final TextEditingController? controller;
  final FocusNode? focusNode;
  final String? label;
  final String? hint;
  final String? helperText;
  final String? errorText;
  final Widget? prefix;
  final Widget? suffix;
  final bool mono;
  final bool enabled;
  final bool readOnly;
  final bool obscureText;
  final TextInputType keyboardType;
  final TextInputAction textInputAction;
  final TextAlign textAlign;
  final int? minLines;
  final int? maxLines;
  final int? maxLength;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final VoidCallback? onTap;
  final bool autofocus;
  final bool autocorrect;
  final SmartDashesType? smartDashesType;
  final SmartQuotesType? smartQuotesType;
  final TextCapitalization textCapitalization;
  final EdgeInsets scrollPadding;
  final List<TextInputFormatter>? inputFormatters;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final labelText = label?.trim();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (labelText != null && labelText.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 5),
            child: Text(
              labelText,
              style: AppTypography.display(
                fontSize: 12,
                fontWeight: FontWeight.w600,
                letterSpacing: 0.15,
                color: colors.onSurfaceVariant,
              ),
            ),
          ),
        TextField(
          controller: controller,
          focusNode: focusNode,
          enabled: enabled,
          readOnly: readOnly,
          obscureText: obscureText,
          keyboardType: keyboardType,
          textInputAction: textInputAction,
          textAlign: textAlign,
          minLines: minLines,
          maxLines: maxLines,
          maxLength: maxLength,
          onChanged: onChanged,
          onSubmitted: onSubmitted,
          onTap: onTap,
          autofocus: autofocus,
          autocorrect: autocorrect,
          smartDashesType: smartDashesType,
          smartQuotesType: smartQuotesType,
          textCapitalization: textCapitalization,
          scrollPadding: scrollPadding,
          inputFormatters: inputFormatters,
          style: mono
              ? AppTypography.mono(fontSize: 15, color: colors.onSurface)
              : AppTypography.body(fontSize: 15, color: colors.onSurface),
          decoration: _inputDecoration(colors),
        ),
      ],
    );
  }

  InputDecoration _inputDecoration(ColorScheme colors) {
    return InputDecoration(
      hintText: hint,
      hintStyle: AppTypography.body(
        fontSize: 15,
        color: colors.onSurfaceVariant.withValues(alpha: 0.72),
      ),
      errorText: errorText,
      errorMaxLines: 3,
      errorStyle: AppTypography.body(
        fontSize: 12,
        color: colors.error,
        height: 1.2,
      ),
      helperText: errorText == null ? helperText : null,
      helperMaxLines: 3,
      helperStyle: AppTypography.body(
        fontSize: 12,
        color: colors.onSurfaceVariant,
        height: 1.2,
      ),
      filled: true,
      fillColor: colors.surfaceContainerHighest,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
      prefixIcon: prefix == null
          ? null
          : Padding(
              padding: const EdgeInsets.only(left: 10, right: 8),
              child: prefix,
            ),
      suffixIcon: suffix == null
          ? null
          : Padding(
              padding: const EdgeInsets.only(right: 10, left: 6),
              child: suffix,
            ),
      prefixIconConstraints: const BoxConstraints(minWidth: 0, minHeight: 0),
      suffixIconConstraints: const BoxConstraints(minWidth: 0, minHeight: 0),
      enabledBorder: OutlineInputBorder(
        borderRadius: AppMotion.controlShape,
        borderSide: BorderSide(color: colors.outlineVariant),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: AppMotion.controlShape,
        borderSide: BorderSide(color: colors.primary),
      ),
      errorBorder: OutlineInputBorder(
        borderRadius: AppMotion.controlShape,
        borderSide: BorderSide(color: colors.error),
      ),
      focusedErrorBorder: OutlineInputBorder(
        borderRadius: AppMotion.controlShape,
        borderSide: BorderSide(color: colors.error),
      ),
      border: OutlineInputBorder(
        borderRadius: AppMotion.controlShape,
        borderSide: BorderSide(color: colors.outlineVariant),
      ),
      isDense: true,
      counterText: "",
    );
  }
}
