import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:overseer_mobile/features/auth/application/auth_controller.dart';
import 'package:overseer_mobile/features/auth/application/auth_state.dart';
import 'package:overseer_mobile/features/auth/presentation/auth_restoring_page.dart';
import 'package:overseer_mobile/features/auth/presentation/sign_in_page.dart';
import 'package:overseer_mobile/features/shell/shell.dart';

class AuthGate extends ConsumerWidget {
  const AuthGate({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authControllerProvider);

    return switch (auth.phase) {
      AuthPhase.restoring => const AuthRestoringPage(),
      AuthPhase.unauthenticated => SignInPage(
        onSignIn: ref.read(authControllerProvider.notifier).signIn,
        errorMessage: auth.errorMessage,
      ),
      AuthPhase.signingIn => SignInPage(
        onSignIn: ref.read(authControllerProvider.notifier).signIn,
        isSigningIn: true,
      ),
      AuthPhase.authenticated => ShellPage(
        user: auth.session!.user,
        onSignOut: ref.read(authControllerProvider.notifier).signOut,
      ),
    };
  }
}
