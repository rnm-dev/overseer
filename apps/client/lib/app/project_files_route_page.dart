import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:overseer_mobile/features/projects/projects.dart';

import 'require_auth.dart';

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
    return RequireAuth(
      child: ProjectFilesPage(
        workspaceId: workspaceId,
        peonId: peonId,
        projectKey: projectKey,
        projectId: projectId,
      ),
    );
  }
}
