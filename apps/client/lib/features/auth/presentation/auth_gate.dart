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

class AuthGate extends ConsumerStatefulWidget {
  const AuthGate({
    super.key,
    this.autoSignIn = false,
    this.onBack,
    this.overseerName,
    required this.buildLoading,
    required this.buildSignIn,
    required this.buildShell,
  });

  final bool autoSignIn;
  final VoidCallback? onBack;
  final String? overseerName;
  final AuthGateLoadingBuilder buildLoading;
  final AuthGateSignInBuilder buildSignIn;
  final AuthGateShellBuilder buildShell;

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
        child: widget.buildLoading(
          overseerName: widget.overseerName,
          onBackToConnections: widget.onBack,
        ),
      );
    }

    final child = switch (auth.phase) {
      AuthPhase.restoring => widget.buildLoading(
        overseerName: widget.overseerName,
        onBackToConnections: widget.onBack,
      ),
      AuthPhase.unavailable => BackendUnavailablePage(
        onRetry: controller.retryRestore,
        onBack: widget.onBack,
      ),
      AuthPhase.unauthenticated => widget.buildSignIn(
        onSignIn: controller.signIn,
        errorMessage: auth.errorMessage,
        isSigningIn: false,
        onBack: widget.onBack,
      ),
      AuthPhase.signingIn =>
        widget.autoSignIn
            ? widget.buildLoading(
                overseerName: widget.overseerName,
                onBackToConnections: widget.onBack,
              )
            : widget.buildSignIn(
                onSignIn: controller.signIn,
                errorMessage: auth.errorMessage,
                isSigningIn: true,
                onBack: widget.onBack,
              ),
      AuthPhase.authenticated => widget.buildShell(
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
