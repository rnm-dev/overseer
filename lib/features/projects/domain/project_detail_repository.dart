import 'project_detail_models.dart';
import 'project_models.dart';

abstract interface class ProjectDetailRepository {
  Future<PeonProject> fetchProject({
    required String workspaceId,
    required String peonId,
    required String projectKey,
  });

  Future<ProjectSettings> fetchSettings({
    required String workspaceId,
    required String peonId,
    required String projectKey,
  });

  Future<ProjectSettings> updateSettings({
    required String workspaceId,
    required String peonId,
    required String projectKey,
    required ProjectSettings settings,
  });

  Future<ProjectDocumentationListing> fetchDocumentation({
    required String workspaceId,
    required String peonId,
    required String projectId,
  });

  Future<ProjectFilePreview> fetchFile({
    required String workspaceId,
    required String peonId,
    required String projectId,
    required String path,
  });

  Future<List<ProjectSkill>> fetchSkills({
    required String workspaceId,
    required String peonId,
    required String projectKey,
  });

  Future<ProjectMembersSnapshot> fetchMembers({required String workspaceId});

  Future<MemberAccess> updateMemberAccess({
    required String workspaceId,
    required String userId,
    required MemberAccess access,
  });
}
