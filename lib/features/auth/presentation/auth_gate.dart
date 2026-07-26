import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:overseer_mobile/features/auth/application/auth_controller.dart';
import 'package:overseer_mobile/features/auth/application/auth_state.dart';
import 'package:overseer_mobile/features/auth/presentation/sign_in_page.dart';
import 'package:overseer_mobile/features/shell/shell.dart';

class AuthGate extends ConsumerStatefulWidget {
  const AuthGate({
    super.key,
    this.autoSignIn = false,
    this.onBack,
    this.overseerName,
  });

  final bool autoSignIn;
  final VoidCallback? onBack;
  final String? overseerName;

  @override
  ConsumerState<AuthGate> createState() => _AuthGateState();
}

class _AuthGateState extends ConsumerState<AuthGate> {
  bool _autoSignInStarted = false;

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authControllerProvider);
    final controller = ref.read(authControllerProvider.notifier);

    if (widget.autoSignIn &&
        auth.phase == AuthPhase.unauthenticated &&
        auth.errorMessage == null &&
        !_autoSignInStarted) {
      _autoSignInStarted = true;
      Future<void>.microtask(controller.signIn);
      return _BackToConnectionsScope(
        onBack: widget.onBack,
        child: ShellPage.loading(
          overseerName: widget.overseerName,
          onBackToConnections: widget.onBack,
        ),
      );
    }

    final child = switch (auth.phase) {
      AuthPhase.restoring => ShellPage.loading(
        overseerName: widget.overseerName,
        onBackToConnections: widget.onBack,
      ),
      AuthPhase.unauthenticated => SignInPage(
        onSignIn: controller.signIn,
        errorMessage: auth.errorMessage,
        onBack: widget.onBack,
      ),
      AuthPhase.signingIn =>
        widget.autoSignIn
            ? ShellPage.loading(
                overseerName: widget.overseerName,
                onBackToConnections: widget.onBack,
              )
            : SignInPage(
                onSignIn: controller.signIn,
                isSigningIn: true,
                onBack: widget.onBack,
              ),
      AuthPhase.authenticated => ShellPage(
        user: auth.session!.user,
        onSignOut: controller.signOut,
        overseerName: widget.overseerName,
        onBackToConnections: widget.onBack,
      ),
    };
    return _BackToConnectionsScope(onBack: widget.onBack, child: child);
  }
}

class _BackToConnectionsScope extends StatelessWidget {
  const _BackToConnectionsScope({required this.onBack, required this.child});

  final VoidCallback? onBack;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final callback = onBack;
    return PopScope<void>(
      canPop: callback == null,
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop) callback?.call();
      },
      child: child,
    );
  }
}
