import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:overseer_mobile/shared/design/colors.dart';
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

  TextStyle get _textStyle => mono
      ? AppTypography.mono(fontSize: 15, color: AppColors.bone)
      : AppTypography.body(fontSize: 15, color: AppColors.bone);

  @override
  Widget build(BuildContext context) {
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
                color: AppColors.boneDim,
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
          style: _textStyle,
          decoration: _inputDecoration(),
        ),
      ],
    );
  }

  InputDecoration _inputDecoration() {
    return InputDecoration(
      hintText: hint,
      hintStyle: AppTypography.body(fontSize: 15, color: AppColors.boneFaint),
      errorText: errorText,
      errorMaxLines: 3,
      errorStyle: AppTypography.body(
        fontSize: 12,
        color: AppColors.blood,
        height: 1.2,
      ),
      helperText: errorText == null ? helperText : null,
      helperMaxLines: 3,
      helperStyle: AppTypography.body(
        fontSize: 12,
        color: AppColors.boneDim,
        height: 1.2,
      ),
      filled: true,
      fillColor: AppColors.rowSurface,
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
      enabledBorder: const OutlineInputBorder(
        borderRadius: AppMotion.controlShape,
        borderSide: BorderSide(color: AppColors.iron700),
      ),
      focusedBorder: const OutlineInputBorder(
        borderRadius: AppMotion.controlShape,
        borderSide: BorderSide(color: AppColors.felDeep),
      ),
      errorBorder: const OutlineInputBorder(
        borderRadius: AppMotion.controlShape,
        borderSide: BorderSide(color: AppColors.blood),
      ),
      focusedErrorBorder: const OutlineInputBorder(
        borderRadius: AppMotion.controlShape,
        borderSide: BorderSide(color: AppColors.rust),
      ),
      border: const OutlineInputBorder(
        borderRadius: AppMotion.controlShape,
        borderSide: BorderSide(color: AppColors.iron700),
      ),
      isDense: true,
      counterText: "",
    );
  }
}
