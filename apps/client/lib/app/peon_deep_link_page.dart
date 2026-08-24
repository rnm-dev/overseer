import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/auth/application/auth_controller.dart';
import '../features/auth/application/auth_state.dart';
import '../features/auth/presentation/backend_unavailable_page.dart';
import '../features/auth/presentation/sign_in_page.dart';
import '../features/fleet/application/fleet_controller.dart';
import '../features/fleet/domain/fleet_models.dart';
import '../features/peon/peon.dart';
import '../features/projects/application/projects_controller.dart';
import '../features/projects/domain/project_models.dart';
import '../features/projects/presentation/new_project_page.dart';
import '../features/sessions/presentation/session_detail_page.dart';
import '../features/sessions/presentation/session_list.dart';
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
      onNewSession: _openNewSession,
      onOpenProject: _openProject,
      onNewProject: _openNewProject,
      sessionListBuilder: _buildSessionList,
    );
  }

  void _openNewSession(
    BuildContext context, {
    required String workspaceId,
    required String peonId,
    String? projectKey,
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

  void _openProject(
    BuildContext context, {
    required String workspaceId,
    required String peonId,
    required PeonProject project,
    required bool online,
    required bool isOwner,
  }) {
    final parameters = <String, String>{
      'workspaceId': workspaceId,
      'peonId': peonId,
      'projectId': project.projectId,
      'projectKey': project.key,
      'isOwner': isOwner ? 'true' : 'false',
      'online': online ? 'true' : 'false',
    };
    if (project.name case final name? when name.isNotEmpty) {
      parameters['projectName'] = name;
    }
    if (project.syncedAt > 0) {
      parameters['syncedAt'] = project.syncedAt.toString();
    }
    context.pushNamed('project', queryParameters: parameters);
  }

  void _openNewProject(
    BuildContext context, {
    required String workspaceId,
    required String peonId,
  }) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => NewProjectPage(
          scope: ProjectsScope(workspaceId: workspaceId, peonId: peonId),
        ),
      ),
    );
  }

  Widget _buildSessionList(
    BuildContext context, {
    required String workspaceId,
    required String peonId,
  }) {
    return SessionSliverList(
      workspaceId: workspaceId,
      peonId: peonId,
      onSessionSelected: (session) => context.pushNamed(
        'session',
        queryParameters: {
          'workspaceId': session.workspaceId,
          'peonId': session.peonId,
          'sessionId': session.sessionId,
        },
      ),
    );
  }
}
