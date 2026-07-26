import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../features/auth/application/auth_controller.dart';
import '../features/auth/application/auth_state.dart';
import '../features/auth/presentation/sign_in_page.dart';
import '../features/fleet/application/fleet_controller.dart';
import '../features/fleet/domain/fleet_models.dart';
import '../features/peon/peon.dart';
import '../features/shell/shell.dart';

class PeonDeepLinkPage extends ConsumerWidget {
  const PeonDeepLinkPage({
    super.key,
    required this.workspaceId,
    required this.peonId,
  });

  final String workspaceId;
  final String peonId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authControllerProvider);
    return switch (auth.phase) {
      AuthPhase.restoring => const ShellPage.loading(),
      AuthPhase.unauthenticated => SignInPage(
        onSignIn: ref.read(authControllerProvider.notifier).signIn,
        errorMessage: auth.errorMessage,
      ),
      AuthPhase.signingIn => SignInPage(
        onSignIn: ref.read(authControllerProvider.notifier).signIn,
        isSigningIn: true,
      ),
      AuthPhase.authenticated => _ResolvedPeonPage(
        workspaceId: workspaceId,
        peonId: peonId,
      ),
    };
  }
}

class _ResolvedPeonPage extends ConsumerWidget {
  const _ResolvedPeonPage({required this.workspaceId, required this.peonId});

  final String workspaceId;
  final String peonId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final fleets = ref.watch(fleetControllerProvider).value;
    Workspace? workspace;
    Peon? peon;
    for (final fleet in fleets ?? const <WorkspaceFleet>[]) {
      if (fleet.workspace.id != workspaceId) continue;
      workspace = fleet.workspace;
      peon = fleet.peons.where((item) => item.id == peonId).firstOrNull;
      break;
    }

    // The identity shell is available immediately, so cached projects and
    // sessions can render while the fleet REST refresh resolves the full row.
    return PeonHomePage(
      workspace:
          workspace ??
          Workspace(id: workspaceId, name: 'Workspace', role: 'member'),
      peon:
          peon ??
          Peon(
            id: peonId,
            online: false,
            lastSeen: 0,
            capabilities: const <String>[],
          ),
    );
  }
}
