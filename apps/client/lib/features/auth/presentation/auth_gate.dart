import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:overseer_mobile/features/auth/application/auth_controller.dart';
import 'package:overseer_mobile/features/auth/application/auth_state.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';
import 'package:overseer_mobile/features/auth/presentation/backend_unavailable_page.dart';

typedef AuthGateLoadingBuilder =
    Widget Function({
      required String? overseerName,
      required VoidCallback? onBackToConnections,
    });

typedef AuthGateSignInBuilder =
    Widget Function({
      required Future<void> Function() onSignIn,
      required String? errorMessage,
      required bool isSigningIn,
      required VoidCallback? onBack,
    });

typedef AuthGateShellBuilder =
    Widget Function({
      required OperatorIdentity user,
      required Future<void> Function() onSignOut,
      String? overseerName,
      VoidCallback? onBackToConnections,
    });

class AuthGate extends ConsumerWidget {
  const AuthGate({
    super.key,
    this.onBack,
    this.overseerName,
    required this.buildLoading,
    required this.buildSignIn,
    required this.buildShell,
  });

  final VoidCallback? onBack;
  final String? overseerName;
  final AuthGateLoadingBuilder buildLoading;
  final AuthGateSignInBuilder buildSignIn;
  final AuthGateShellBuilder buildShell;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authControllerProvider);
    final controller = ref.read(authControllerProvider.notifier);

    final child = switch (auth.phase) {
      AuthPhase.restoring => buildLoading(
        overseerName: overseerName,
        onBackToConnections: onBack,
      ),
      AuthPhase.unavailable => BackendUnavailablePage(
        onRetry: controller.retryRestore,
        onBack: onBack,
      ),
      AuthPhase.unauthenticated || AuthPhase.signingIn => buildSignIn(
        onSignIn: controller.signIn,
        errorMessage: auth.errorMessage,
        isSigningIn: auth.phase == AuthPhase.signingIn,
        onBack: onBack,
      ),
      AuthPhase.authenticated => buildShell(
        user: auth.session!.user,
        onSignOut: controller.signOut,
        overseerName: overseerName,
        onBackToConnections: onBack,
      ),
    };
    return _BackToConnectionsScope(onBack: onBack, child: child);
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
