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

typedef ProjectFileViewerScope = ({
  String workspaceId,
  String peonId,
  String projectKey,
  String path,
  String? projectId,
});

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
