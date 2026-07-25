import '../../../core/live/live_projection_sink.dart';
import 'project_detail_models.dart';
import 'project_models.dart';

abstract interface class ProjectRepository implements LiveProjectionSink {
  Future<List<PeonProject>> loadCachedProjects({
    required String workspaceId,
    required String peonId,
  });

  Stream<List<PeonProject>> watchProjects({
    required String workspaceId,
    required String peonId,
  });

  Future<ProjectSnapshot> refreshProjects({
    required String workspaceId,
    required String peonId,
  });

  Future<ProjectSuggestion> suggestProject({
    required String workspaceId,
    required String peonId,
    required String label,
  });

  Future<void> createProject({
    required String workspaceId,
    required String peonId,
    required String label,
    String? dir,
    String? metadata,
  });

  Future<ProjectDirectory> fetchDirectory({
    required String workspaceId,
    required String peonId,
    required String projectKey,
    required String path,
  });

  Future<ProjectFilePreview> fetchFile({
    required String workspaceId,
    required String peonId,
    required String projectKey,
    required String path,
  });
}
