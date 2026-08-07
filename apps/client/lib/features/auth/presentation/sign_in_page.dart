import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:overseer_mobile/shared/design/colors.dart';
import 'package:overseer_mobile/shared/design/spacing.dart';
import 'package:overseer_mobile/shared/design/typography.dart';
import 'package:overseer_mobile/shared/widgets/app_button.dart';
import 'package:overseer_mobile/shared/widgets/app_page_header.dart';
import 'package:overseer_mobile/l10n/l10n.dart';

/// Signed-out landing page.
///
/// Authentication remains outside the widget. [onSignIn] starts the GitHub
/// flow, while [isSigningIn] protects against duplicate attempts.
class SignInPage extends StatelessWidget {
  const SignInPage({
    super.key,
    required this.onSignIn,
    this.isSigningIn = false,
    this.errorMessage,
    this.onBack,
  });

  final VoidCallback? onSignIn;
  final bool isSigningIn;
  final String? errorMessage;
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
            children: <Widget>[
              if (onBack != null)
                Align(
                  alignment: Alignment.topLeft,
                  child: IconButton(
                    key: const Key('auth-back-to-connections'),
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
                      children: <Widget>[
                        AppPageHeader(
                          title: l10n.signInTitle,
                          subtitle: l10n.signInSubtitle,
                        ),
                        if (errorMessage != null) ...<Widget>[
                          const SizedBox(height: 20),
                          Semantics(
                            liveRegion: true,
                            child: Text(
                              errorMessage!,
                              key: const Key('sign-in-error'),
                              textAlign: TextAlign.center,
                              style: AppTypography.body(
                                fontSize: 13,
                                color: AppThemePalette.of(context).danger,
                                height: 1.4,
                              ),
                            ),
                          ),
                        ],
                        const SizedBox(height: 24),
                        AppButton(
                          key: const Key('github-sign-in-button'),
                          onPressed: onSignIn,
                          loading: isSigningIn,
                          disabled: isSigningIn,
                          fullWidth: true,
                          size: AppButtonSize.lg,
                          child: Text(
                            isSigningIn ? l10n.connecting : l10n.signIn,
                          ),
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
