import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/auth/application/auth_controller.dart';
import '../features/auth/application/auth_state.dart';
import '../features/auth/presentation/backend_unavailable_page.dart';
import '../features/auth/presentation/sign_in_page.dart';
import '../features/fleet/application/fleet_controller.dart';
import '../features/projects/application/projects_controller.dart';
import '../features/projects/domain/project_models.dart';
import '../features/projects/presentation/project_detail_page.dart';
import '../features/sessions/presentation/session_detail_page.dart';
import '../features/sessions/presentation/session_list.dart';
import '../features/projects/presentation/project_file_viewer_page.dart';
import '../features/shell/shell.dart';

class ProjectDetailRoutePage extends ConsumerWidget {
  const ProjectDetailRoutePage({
    super.key,
    required this.workspaceId,
    required this.peonId,
    required this.projectId,
    required this.projectKey,
    this.projectName,
    this.projectSyncedAt,
    this.isOwner = false,
  });

  final String workspaceId;
  final String peonId;
  final String projectId;
  final String projectKey;
  final String? projectName;
  final String? projectSyncedAt;
  final bool isOwner;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authControllerProvider);
    final controller = ref.read(authControllerProvider.notifier);
    final project = _resolveProject(ref);

    if (auth.phase == AuthPhase.signingIn) {
      return SignInPage(onSignIn: controller.signIn, isSigningIn: true);
    }

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
      AuthPhase.authenticated => ProjectDetailPage(
        workspaceId: workspaceId,
        peonId: peonId,
        project: project,
        online: _isPeonOnline(ref),
        isOwner: isOwner,
        onNewSession: _openProjectSession,
        onOpenFile: _openProjectFile,
        sessionListBuilder:
            (
              context, {
              required String workspaceId,
              required String peonId,
              required String projectId,
              required String projectKey,
            }) {
              return SessionList(
                workspaceId: workspaceId,
                peonId: peonId,
                projectId: projectId,
                projectKey: projectKey,
                onSessionSelected: (session) => context.pushNamed(
                  'session',
                  queryParameters: {
                    'workspaceId': session.workspaceId,
                    'peonId': session.peonId,
                    'sessionId': session.sessionId,
                  },
                ),
              );
            },
      ),
    };
  }

  void _openProjectSession(
    BuildContext context, {
    required String workspaceId,
    required String peonId,
    required String projectKey,
  }) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => SessionDetailPage.newSession(
          workspaceId: workspaceId,
          peonId: peonId,
          projectKey: projectKey,
        ),
      ),
    );
  }

  void _openProjectFile(
    BuildContext context, {
    required String workspaceId,
    required String peonId,
    required String projectId,
    required String projectKey,
    required String path,
  }) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ProjectFileViewerPage(
          workspaceId: workspaceId,
          peonId: peonId,
          projectId: projectId,
          projectKey: projectKey,
          path: path,
        ),
      ),
    );
  }

  PeonProject _resolveProject(WidgetRef ref) {
    final state = ref.watch(
      projectsControllerProvider(
        ProjectsScope(workspaceId: workspaceId, peonId: peonId),
      ),
    );
    final projects = state.value?.projects;
    if (projects != null) {
      for (final candidate in projects) {
        if (candidate.projectId == projectId && candidate.key == projectKey) {
          return candidate;
        }
      }
      for (final candidate in projects) {
        if (candidate.projectId == projectId) return candidate;
      }
    }

    return PeonProject(
      workspaceId: workspaceId,
      peonId: peonId,
      projectId: projectId,
      key: projectKey,
      name: projectName,
      syncedAt: _parseSyncedAt(projectSyncedAt),
    );
  }

  static double _parseSyncedAt(String? value) {
    final parsed = double.tryParse(value ?? '');
    if (parsed != null && parsed.isFinite) return parsed;
    return 0;
  }

  bool _isPeonOnline(WidgetRef ref) {
    final fleets = ref.watch(fleetControllerProvider);
    final data = fleets.value;
    if (data == null) return false;
    for (final fleet in data) {
      if (fleet.workspace.id != workspaceId) continue;
      for (final peon in fleet.peons) {
        if (peon.id == peonId) return peon.online;
      }
    }
    return false;
  }
}
