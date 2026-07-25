import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/project_detail_models.dart';
import 'project_detail_controller.dart';
import 'projects_controller.dart';

final projectFileViewerControllerProvider = AsyncNotifierProvider.autoDispose
    .family<
      ProjectFileViewerController,
      ProjectFilePreview,
      ProjectFileViewerScope
    >(ProjectFileViewerController.new, retry: (_, _) => null);

class ProjectFileViewerScope {
  const ProjectFileViewerScope({
    required this.workspaceId,
    required this.peonId,
    required this.projectKey,
    required this.path,
    this.projectId,
  });

  final String workspaceId;
  final String peonId;
  final String projectKey;
  final String path;
  final String? projectId;

  @override
  bool operator ==(Object other) =>
      other is ProjectFileViewerScope &&
      other.workspaceId == workspaceId &&
      other.peonId == peonId &&
      other.projectKey == projectKey &&
      other.projectId == projectId &&
      other.path == path;

  @override
  int get hashCode =>
      Object.hash(workspaceId, peonId, projectKey, projectId, path);
}

class ProjectFileViewerController extends AsyncNotifier<ProjectFilePreview> {
  ProjectFileViewerController(this.scope);

  final ProjectFileViewerScope scope;

  @override
  Future<ProjectFilePreview> build() => _fetch();

  Future<ProjectFilePreview> _fetch() {
    final projectId = scope.projectId?.trim();
    if (projectId != null && projectId.isNotEmpty) {
      return ref
          .read(projectDetailRepositoryProvider)
          .fetchFile(
            workspaceId: scope.workspaceId,
            peonId: scope.peonId,
            projectId: projectId,
            path: scope.path,
          );
    }
    return ref
        .read(projectRepositoryProvider)
        .fetchFile(
          workspaceId: scope.workspaceId,
          peonId: scope.peonId,
          projectKey: scope.projectKey,
          path: scope.path,
        );
  }
}
