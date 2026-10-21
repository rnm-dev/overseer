import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../features/auth/application/auth_controller.dart';
import '../features/auth/application/auth_state.dart';
import '../features/auth/presentation/backend_unavailable_page.dart';
import '../features/auth/presentation/sign_in_page.dart';
import '../features/shell/shell.dart';

/// Shows [child] only once authenticated; deep-link routes use this instead
/// of `AuthGate` so they get no back button and never auto sign in.
class RequireAuth extends ConsumerWidget {
  const RequireAuth({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authControllerProvider);
    final controller = ref.read(authControllerProvider.notifier);
    return switch (auth.phase) {
      AuthPhase.restoring => const ShellPage.loading(),
      AuthPhase.unavailable => BackendUnavailablePage(
        onRetry: controller.retryRestore,
      ),
      AuthPhase.unauthenticated => SignInPage(
        onSignIn: controller.signIn,
        errorMessage: auth.errorMessage,
      ),
      AuthPhase.signingIn => SignInPage(
        onSignIn: controller.signIn,
        isSigningIn: true,
      ),
      AuthPhase.authenticated => child,
    };
  }
}
