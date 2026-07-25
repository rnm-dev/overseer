import 'package:flutter/material.dart';
import 'package:overseer_mobile/shared/design/colors.dart';
import 'package:overseer_mobile/shared/design/spacing.dart';
import 'package:overseer_mobile/shared/design/typography.dart';
import 'package:overseer_mobile/shared/widgets/app_button.dart';
import 'package:overseer_mobile/shared/widgets/overseer_logo.dart';

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
    this.logo = const OverseerLogo(),
  });

  final VoidCallback? onSignIn;
  final bool isSigningIn;
  final String? errorMessage;
  final Widget logo;

  static const String _heroAssetPath = 'assets/images/sign-in-hero.png';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        fit: StackFit.expand,
        children: <Widget>[
          const Image(
            key: Key('sign-in-hero'),
            image: AssetImage(_heroAssetPath),
            fit: BoxFit.cover,
            filterQuality: FilterQuality.high,
            excludeFromSemantics: true,
          ),
          const DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: <Color>[
                  Color(0x1A060806),
                  Color(0x40060806),
                  AppColors.voidColor,
                ],
                stops: <double>[0, 0.48, 1],
              ),
            ),
          ),
          SafeArea(
            child: Padding(
              padding: context.appSpacing.screenInsets(top: 20, bottom: 20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  Center(child: logo),
                  const Spacer(),
                  if (errorMessage != null) ...<Widget>[
                    Semantics(
                      liveRegion: true,
                      child: Text(
                        errorMessage!,
                        key: const Key('sign-in-error'),
                        textAlign: TextAlign.center,
                        style: AppTypography.body(
                          fontSize: 13,
                          color: AppColors.blood,
                          height: 1.4,
                        ),
                      ),
                    ),
                    const SizedBox(height: 16),
                  ],
                  AppButton(
                    key: const Key('github-sign-in-button'),
                    onPressed: onSignIn,
                    loading: isSigningIn,
                    disabled: isSigningIn,
                    fullWidth: true,
                    size: AppButtonSize.lg,
                    child: Text(isSigningIn ? 'Connecting…' : 'Sign In'),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
