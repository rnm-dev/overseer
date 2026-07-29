import 'dart:async';

import 'package:flutter/material.dart';

import '../../../shared/design/colors.dart';
import '../../../shared/design/motion.dart';
import '../../../shared/design/typography.dart';
import '../../../shared/widgets/app_bottom_sheet.dart';
import '../../../shared/widgets/app_button.dart';

Future<void> showVoiceInputAlertSheet({
  required BuildContext context,
  required String message,
  required bool canOpenSettings,
  required Future<bool> Function() openSettings,
}) {
  return showAppBottomSheet<void>(
    context: context,
    builder: (sheetContext) => AppBottomSheet(
      title: 'Voice input',
      handleKey: const Key('voice-input-alert-handle'),
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                message,
                key: const Key('voice-input-alert-message'),
                textAlign: TextAlign.center,
                style: AppTypography.body(
                  fontSize: 14,
                  color: AppColors.boneDim,
                  height: 1.45,
                ),
              ),
              const SizedBox(height: 20),
              if (canOpenSettings) ...[
                AppButton(
                  key: const Key('voice-input-open-settings'),
                  onPressed: () {
                    Navigator.of(sheetContext).pop();
                    unawaited(openSettings());
                  },
                  fullWidth: true,
                  size: AppButtonSize.lg,
                  borderRadius: AppMotion.optionShape,
                  child: const Text('Open settings'),
                ),
                const SizedBox(height: 10),
                AppButton(
                  key: const Key('voice-input-alert-dismiss'),
                  onPressed: () => Navigator.of(sheetContext).pop(),
                  variant: AppButtonVariant.secondary,
                  fullWidth: true,
                  size: AppButtonSize.lg,
                  borderRadius: AppMotion.optionShape,
                  child: const Text('Not now'),
                ),
              ] else
                AppButton(
                  key: const Key('voice-input-alert-dismiss'),
                  onPressed: () => Navigator.of(sheetContext).pop(),
                  fullWidth: true,
                  size: AppButtonSize.lg,
                  borderRadius: AppMotion.optionShape,
                  child: const Text('OK'),
                ),
            ],
          ),
        ),
      ],
    ),
  );
}
