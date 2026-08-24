import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:overseer_mobile/features/auth/application/auth_controller.dart';
import 'package:overseer_mobile/features/auth/application/auth_state.dart';
import 'package:overseer_mobile/features/auth/presentation/backend_unavailable_page.dart';
import 'package:overseer_mobile/features/auth/presentation/sign_in_page.dart';
import 'package:overseer_mobile/features/projects/projects.dart';
import 'package:overseer_mobile/features/shell/shell.dart';

class ProjectFilesRoutePage extends ConsumerWidget {
  const ProjectFilesRoutePage({
    super.key,
    required this.workspaceId,
    required this.peonId,
    this.projectKey,
    this.projectId,
  });

  final String workspaceId;
  final String peonId;
  final String? projectKey;
  final String? projectId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authControllerProvider);
    return switch (auth.phase) {
      AuthPhase.restoring => const ShellPage.loading(),
      AuthPhase.unavailable => BackendUnavailablePage(
        onRetry: ref.read(authControllerProvider.notifier).retryRestore,
      ),
      AuthPhase.unauthenticated => SignInPage(
        onSignIn: ref.read(authControllerProvider.notifier).signIn,
        errorMessage: auth.errorMessage,
      ),
      AuthPhase.signingIn => SignInPage(
        onSignIn: ref.read(authControllerProvider.notifier).signIn,
        isSigningIn: true,
      ),
      AuthPhase.authenticated => ProjectFilesPage(
        workspaceId: workspaceId,
        peonId: peonId,
        projectKey: projectKey,
        projectId: projectId,
      ),
    };
  }
}
