import 'dart:typed_data';

import 'package:dio/dio.dart';

import '../../../core/network/overseer_http_client.dart';
import '../domain/project_detail_models.dart';
import '../domain/project_detail_repository.dart';
import '../domain/project_models.dart';

class DioProjectDetailRepository implements ProjectDetailRepository {
  DioProjectDetailRepository({
    required Uri apiUrl,
    required String token,
    Dio? dio,
  }) : _dio = dio ?? createOverseerHttpClient(apiUrl: apiUrl, token: token);

  final Dio _dio;

  String _peonBase(String workspaceId, String peonId) =>
      'workspaces/${Uri.encodeComponent(workspaceId)}/peons/'
      '${Uri.encodeComponent(peonId)}';

  @override
  Future<PeonProject> fetchProject({
    required String workspaceId,
    required String peonId,
    required String projectKey,
  }) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '${_peonBase(workspaceId, peonId)}/projects/'
        '${Uri.encodeComponent(projectKey)}',
      );
      final json = response.data;
      if (json == null) throw const FormatException();
      return PeonProject(
        workspaceId: workspaceId,
        peonId: peonId,
        projectId: json['projectId'] as String? ?? 'legacy:$projectKey',
        key: json['key'] as String? ?? projectKey,
        name: (json['name'] ?? json['label']) as String?,
        dir: (json['dir'] ?? json['path']) as String?,
        metadata: json['metadata'] as String?,
        sessionCount: (json['sessionCount'] as num?)?.toInt() ?? 0,
        memberCount: (json['memberCount'] as num?)?.toInt() ?? 0,
        activeCount: (json['activeCount'] as num?)?.toInt() ?? 0,
        lastActivityMs: (json['lastActivityMs'] as num?)?.toDouble(),
        syncedAt: (json['syncedAt'] as num?)?.toDouble() ?? 0,
      );
    } on DioException catch (error) {
      throw _exception(error, 'Could not load the project.');
    } on Object {
      throw const ProjectsException(
        'Overseer returned an invalid project response.',
      );
    }
  }

  @override
  Future<ProjectSettings> fetchSettings({
    required String workspaceId,
    required String peonId,
    required String projectKey,
  }) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '${_peonBase(workspaceId, peonId)}/projects/'
        '${Uri.encodeComponent(projectKey)}/settings',
      );
      return _settings(response.data);
    } on DioException catch (error) {
      throw _exception(error, 'Could not load project settings.');
    } on Object {
      throw const ProjectsException(
        'Overseer returned invalid project settings.',
      );
    }
  }

  @override
  Future<ProjectSettings> updateSettings({
    required String workspaceId,
    required String peonId,
    required String projectKey,
    required ProjectSettings settings,
  }) async {
    try {
      final response = await _dio.patch<Map<String, dynamic>>(
        '${_peonBase(workspaceId, peonId)}/projects/'
        '${Uri.encodeComponent(projectKey)}/settings',
        data: {
          'key': settings.key,
          'name': settings.name,
          'dir': settings.dir,
          'metadata': settings.metadata,
        },
      );
      return _settings(response.data);
    } on DioException catch (error) {
      throw _exception(error, 'Could not save project settings.');
    } on Object {
      throw const ProjectsException(
        'Overseer returned invalid project settings.',
      );
    }
  }

  @override
  Future<ProjectDocumentationListing> fetchDocumentation({
    required String workspaceId,
    required String peonId,
    required String projectId,
  }) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '${_peonBase(workspaceId, peonId)}/projects/'
        '${Uri.encodeComponent(projectId)}/docs',
      );
      final json = response.data;
      final rawEntries = json?['entries'];
      if (json == null || rawEntries is! List) throw const FormatException();
      return ProjectDocumentationListing(
        exists: json['exists'] as bool? ?? false,
        entries: rawEntries
            .map((value) {
              final item = Map<String, dynamic>.from(value as Map);
              return ProjectDocumentationEntry(
                name: item['name'] as String,
                type: item['type'] as String,
              );
            })
            .toList(growable: false),
      );
    } on DioException catch (error) {
      throw _exception(error, 'Project documentation could not be loaded.');
    } on Object {
      throw const ProjectsException(
        'Overseer returned invalid project documentation.',
      );
    }
  }

  @override
  Future<ProjectFilePreview> fetchFile({
    required String workspaceId,
    required String peonId,
    required String projectId,
    required String path,
  }) async {
    final encoded = path
        .split('/')
        .where((part) => part.isNotEmpty)
        .map(Uri.encodeComponent)
        .join('/');
    try {
      final response = await _dio.get<List<int>>(
        '${_peonBase(workspaceId, peonId)}/projects/by-id/'
        '${Uri.encodeComponent(projectId)}/files/$encoded',
        options: Options(responseType: ResponseType.bytes),
      );
      return ProjectFilePreview(
        path: path,
        bytes: Uint8List.fromList(response.data ?? const []),
        contentType: response.headers.value(Headers.contentTypeHeader),
      );
    } on DioException catch (error) {
      throw _exception(error, 'Could not preview this file.');
    }
  }

  @override
  Future<List<ProjectSkill>> fetchSkills({
    required String workspaceId,
    required String peonId,
    required String projectKey,
  }) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '${_peonBase(workspaceId, peonId)}/projects/'
        '${Uri.encodeComponent(projectKey)}/skills',
      );
      final raw = response.data?['skills'];
      if (raw is! List) throw const FormatException();
      return raw
          .map((value) {
            final item = Map<String, dynamic>.from(value as Map);
            final name = item['name'];
            final description = item['description'];
            if (name is! String ||
                name.trim().isEmpty ||
                description is! String) {
              throw const FormatException();
            }
            return ProjectSkill(
              name: name,
              description: description,
              path: item['path'] as String?,
            );
          })
          .toList(growable: false);
    } on DioException catch (error) {
      throw _exception(error, 'Could not load project skills.');
    } on Object {
      throw const ProjectsException(
        'Overseer returned an invalid skills response.',
      );
    }
  }

  @override
  Future<ProjectMembersSnapshot> fetchMembers({
    required String workspaceId,
  }) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        'workspaces/${Uri.encodeComponent(workspaceId)}/members',
      );
      final raw = response.data?['members'];
      if (raw is! List) throw const FormatException();
      final members = raw
          .map((value) {
            final item = Map<String, dynamic>.from(value as Map);
            return WorkspaceMember(
              userId: item['userId'] as String,
              email: item['email'] as String,
              role: item['role'] as String,
              githubLogin: item['githubLogin'] as String?,
              avatarUrl: item['avatarUrl'] as String?,
            );
          })
          .toList(growable: false);
      final accessEntries = await Future.wait(
        members.where((member) => member.role == 'member').map((member) async {
          final result = await _dio.get<Map<String, dynamic>>(
            'workspaces/${Uri.encodeComponent(workspaceId)}/members/'
            '${Uri.encodeComponent(member.userId)}/access',
          );
          return MapEntry(member.userId, _access(result.data?['access']));
        }),
      );
      return ProjectMembersSnapshot(
        members: members,
        accessByMember: Map.fromEntries(accessEntries),
      );
    } on DioException catch (error) {
      throw _exception(error, 'Could not load project members.');
    } on Object {
      throw const ProjectsException(
        'Overseer returned invalid project member access.',
      );
    }
  }

  @override
  Future<MemberAccess> updateMemberAccess({
    required String workspaceId,
    required String userId,
    required MemberAccess access,
  }) async {
    try {
      await _dio.put<Map<String, dynamic>>(
        'workspaces/${Uri.encodeComponent(workspaceId)}/members/'
        '${Uri.encodeComponent(userId)}/access',
        data: _accessJson(access),
      );
      return access;
    } on DioException catch (error) {
      throw _exception(error, 'Could not save project access.');
    }
  }

  ProjectSettings _settings(Map<String, dynamic>? json) {
    if (json == null) throw const FormatException();
    return ProjectSettings(
      projectId: json['projectId'] as String?,
      key: json['key'] as String,
      name: json['name'] as String,
      dir: json['dir'] as String,
      metadata: json['metadata'] as String?,
    );
  }

  MemberAccess _access(Object? value) {
    final json = Map<String, dynamic>.from(value as Map);
    final peonIds = (json['peonIds'] as List).cast<String>();
    final projects = (json['projects'] as List)
        .map((value) {
          final item = Map<String, dynamic>.from(value as Map);
          return ProjectAccessReference(
            peonId: item['peonId'] as String,
            projectKey: item['projectKey'] as String,
            projectId: item['projectId'] as String?,
          );
        })
        .toList(growable: false);
    return MemberAccess(peonIds: peonIds, projects: projects);
  }

  Map<String, dynamic> _accessJson(MemberAccess access) => {
    'peonIds': access.peonIds,
    'projects': [
      for (final project in access.projects)
        {
          'peonId': project.peonId,
          'projectKey': project.projectKey,
          'projectId': project.projectId,
        },
    ],
  };

  ProjectsException _exception(DioException error, String fallback) {
    final data = error.response?.data;
    final message = data is Map ? data['error'] as String? : null;
    final code = data is Map ? data['code'] as String? : null;
    return ProjectsException(message ?? fallback, code: code);
  }
}
