import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../features/projects/projects.dart';
import '../features/sessions/sessions.dart';
import '../features/shell/shell.dart';

Widget buildDesktopFleetSidebar(
  BuildContext context, {
  GlobalKey<NavigatorState>? navigatorKey,
}) => DesktopFleetSidebar(
  onProject: (context, workspace, peon, project) => context.pushNamed(
    'project',
    queryParameters: {
      'workspaceId': workspace.id,
      'peonId': peon.id,
      'projectId': project.projectId,
      'projectKey': project.key,
      if (project.name != null) 'projectName': project.name!,
      'syncedAt': project.syncedAt.toString(),
      'online': peon.online.toString(),
      'isOwner': (workspace.role == null || workspace.role == 'owner')
          .toString(),
    },
  ),
  onSession: (context, session) => context.pushNamed(
    'session',
    queryParameters: {
      'workspaceId': session.workspaceId,
      'peonId': session.peonId,
      'sessionId': session.sessionId,
    },
  ),
  onNewProject: (context, scope) =>
      (navigatorKey?.currentState ?? Navigator.of(context)).push(
        MaterialPageRoute<void>(builder: (_) => NewProjectPage(scope: scope)),
      ),
  onNewSession: (context, scope, projectKey) =>
      (navigatorKey?.currentState ?? Navigator.of(context)).push(
        MaterialPageRoute<void>(
          builder: (_) => SessionDetailPage.newSession(
            workspaceId: scope.workspaceId,
            peonId: scope.peonId,
            projectKey: projectKey,
          ),
        ),
      ),
);
