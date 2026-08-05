import 'package:flutter/material.dart';
import '../design/motion.dart';
import '../design/typography.dart';
import 'app_bottom_sheet.dart';
import 'app_button.dart';

Future<bool> showAppConfirmationBottomSheet({
  required BuildContext context,
  required String title,
  required String message,
  required String confirmLabel,
  String cancelLabel = 'Cancel',
  bool destructive = false,
}) async {
  final confirmed = await showAppBottomSheet<bool>(
    context: context,
    builder: (context) => _ConfirmationSheet(
      title: title,
      message: message,
      confirmLabel: confirmLabel,
      cancelLabel: cancelLabel,
      destructive: destructive,
    ),
  );
  return confirmed ?? false;
}

class _ConfirmationSheet extends StatelessWidget {
  const _ConfirmationSheet({
    required this.title,
    required this.message,
    required this.confirmLabel,
    required this.cancelLabel,
    required this.destructive,
  });

  final String title;
  final String message;
  final String confirmLabel;
  final String cancelLabel;
  final bool destructive;

  @override
  Widget build(BuildContext context) {
    return AppBottomSheet(
      title: title,
      handleKey: const Key('confirmation-sheet-handle'),
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                message,
                textAlign: TextAlign.center,
                style: AppTypography.body(
                  fontSize: 14,
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                  height: 1.45,
                ),
              ),
              const SizedBox(height: 20),
              AppButton(
                key: const Key('confirmation-confirm'),
                onPressed: () => Navigator.of(context).pop(true),
                variant: destructive
                    ? AppButtonVariant.danger
                    : AppButtonVariant.primary,
                size: AppButtonSize.lg,
                fullWidth: true,
                borderRadius: AppMotion.optionShape,
                child: Text(confirmLabel),
              ),
              const SizedBox(height: 10),
              AppButton(
                key: const Key('confirmation-cancel'),
                onPressed: () => Navigator.of(context).pop(false),
                variant: AppButtonVariant.secondary,
                size: AppButtonSize.lg,
                fullWidth: true,
                borderRadius: AppMotion.optionShape,
                child: Text(cancelLabel),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
