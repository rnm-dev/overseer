import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:overseer_mobile/l10n/l10n.dart';
import 'package:overseer_mobile/shared/design/colors.dart';
import 'package:overseer_mobile/shared/design/spacing.dart';
import 'package:overseer_mobile/shared/widgets/app_button.dart';
import 'package:overseer_mobile/shared/widgets/app_page_header.dart';

class BackendUnavailablePage extends StatelessWidget {
  const BackendUnavailablePage({super.key, required this.onRetry, this.onBack});

  final VoidCallback onRetry;
  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: context.appSpacing.screenInsets(top: 20, bottom: 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (onBack != null)
                Align(
                  alignment: Alignment.topLeft,
                  child: IconButton(
                    key: const Key('unavailable-back-to-connections'),
                    tooltip: l10n.backToOverseers,
                    onPressed: onBack,
                    icon: Icon(
                      LucideIcons.arrowLeft,
                      color: AppThemePalette.of(context).ink,
                    ),
                  ),
                ),
              Expanded(
                child: Center(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 520),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        AppPageHeader(
                          title: l10n.backendUnavailableTitle,
                          subtitle: l10n.backendUnavailableMessage,
                        ),
                        const SizedBox(height: 24),
                        AppButton(
                          key: const Key('backend-unavailable-retry'),
                          onPressed: onRetry,
                          fullWidth: true,
                          size: AppButtonSize.lg,
                          child: Text(l10n.tryAgain),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
