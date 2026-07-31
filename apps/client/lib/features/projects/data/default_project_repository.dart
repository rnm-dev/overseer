import 'package:dio/dio.dart';
import 'package:drift/drift.dart';

import '../../../core/database/app_database.dart';
import '../../../core/network/overseer_http_client.dart';
import '../domain/project_detail_models.dart';
import '../domain/project_models.dart';
import '../domain/project_repository.dart';

class DefaultProjectRepository implements ProjectRepository {
  DefaultProjectRepository({
    required this.database,
    required Uri apiUrl,
    required String token,
    Dio? dio,
  }) : _dio = dio ?? createOverseerHttpClient(apiUrl: apiUrl, token: token);

  final AppDatabase database;
  final Dio _dio;

  SimpleSelectStatement<$CachedProjectsTable, CachedProject> _projectQuery({
    required String workspaceId,
    required String peonId,
  }) {
    return database.select(database.cachedProjects)
      ..where(
        (row) =>
            row.workspaceId.equals(workspaceId) &
            row.peonId.equals(peonId) &
            row.deleted.equals(false),
      )
      ..orderBy([
        (row) => OrderingTerm.asc(row.name),
        (row) => OrderingTerm.asc(row.projectKey),
      ]);
  }

  @override
  Future<List<PeonProject>> loadCachedProjects({
    required String workspaceId,
    required String peonId,
  }) async {
    final rows = await _projectQuery(
      workspaceId: workspaceId,
      peonId: peonId,
    ).get();
    return _sorted(rows.map(_domainFromRow));
  }

  @override
  Stream<List<PeonProject>> watchProjects({
    required String workspaceId,
    required String peonId,
  }) {
    return _projectQuery(
      workspaceId: workspaceId,
      peonId: peonId,
    ).watch().map((rows) => _sorted(rows.map(_domainFromRow)));
  }

  @override
  Future<ProjectSnapshot> refreshProjects({
    required String workspaceId,
    required String peonId,
  }) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        'workspaces/${Uri.encodeComponent(workspaceId)}/peons/'
        '${Uri.encodeComponent(peonId)}/projects',
      );
      final payload = response.data;
      final rawProjects = payload?['projects'];
      if (rawProjects is! List) {
        throw const FormatException('Invalid projects response');
      }
      final projects = rawProjects
          .map(
            (item) => _domainFromJson(
              workspaceId,
              peonId,
              Map<String, dynamic>.from(item as Map),
            ),
          )
          .toList(growable: false);
      await database.transaction(() async {
        await database.batch((batch) {
          for (final project in projects) {
            batch.insert(
              database.cachedProjects,
              _companion(project),
              onConflict: DoUpdate<CachedProjects, CachedProject>(
                (_) => _companion(project),
                where: (old) =>
                    old.syncedAt.isSmallerThanValue(project.syncedAt) |
                    (old.syncedAt.equals(project.syncedAt) &
                        old.deleted.equals(false)),
              ),
            );
          }
        });

        final projectIds = projects.map((project) => project.projectId).toList();
        final staleRows = database.update(database.cachedProjects)
          ..where(
            (row) =>
                row.workspaceId.equals(workspaceId) &
                row.peonId.equals(peonId) &
                row.deleted.equals(false) &
                (projectIds.isEmpty
                    ? const Constant(true)
                    : row.projectId.isNotIn(projectIds)),
          );
        await staleRows.write(
          const CachedProjectsCompanion(deleted: Value(true)),
        );
      });
      final rawCatalog = payload?['catalog'];
      final catalog = rawCatalog is Map
          ? ProjectCatalog(
              state: rawCatalog['state'] as String? ?? 'legacy',
              stale: rawCatalog['stale'] as bool? ?? false,
              updatedAt: (rawCatalog['updatedAt'] as num?)?.toDouble(),
            )
          : const ProjectCatalog(state: 'legacy', stale: false);
      return ProjectSnapshot(projects: projects, catalog: catalog);
    } on DioException catch (error) {
      final data = error.response?.data;
      final message = data is Map<String, dynamic>
          ? data['error'] as String?
          : null;
      throw ProjectsException(
        message ??
            'Could not refresh projects. Cached projects are still available.',
      );
    } on FormatException {
      throw const ProjectsException(
        'Overseer returned an invalid projects response.',
      );
    } on TypeError {
      throw const ProjectsException(
        'Overseer returned an invalid projects response.',
      );
    }
  }

  @override
  Future<ProjectSuggestion> suggestProject({
    required String workspaceId,
    required String peonId,
    required String label,
  }) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        'workspaces/${Uri.encodeComponent(workspaceId)}/peons/'
        '${Uri.encodeComponent(peonId)}/projects/suggest-dir',
        queryParameters: {'label': label},
      );
      final payload = response.data;
      return ProjectSuggestion(
        key: payload?['key'] as String?,
        dir: payload?['dir'] as String?,
      );
    } on DioException catch (error) {
      throw _projectsException(error, 'Could not suggest a project directory.');
    } on TypeError {
      throw const ProjectsException(
        'Overseer returned an invalid project suggestion.',
      );
    }
  }

  @override
  Future<void> createProject({
    required String workspaceId,
    required String peonId,
    required String label,
    String? dir,
    String? metadata,
  }) async {
    final data = <String, dynamic>{'label': label, 'metadata': metadata};
    if (dir case final value?) data['dir'] = value;
    try {
      await _dio.post<Map<String, dynamic>>(
        'workspaces/${Uri.encodeComponent(workspaceId)}/peons/'
        '${Uri.encodeComponent(peonId)}/projects',
        data: data,
      );
    } on DioException catch (error) {
      throw _projectsException(error, 'Could not create the project.');
    }
  }

  @override
  Future<ProjectDirectory> fetchDirectory({
    required String workspaceId,
    required String peonId,
    required String projectKey,
    required String path,
  }) async {
    final encodedPath = path
        .split('/')
        .where((segment) => segment.isNotEmpty)
        .map(Uri.encodeComponent)
        .join('/');
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        'workspaces/${Uri.encodeComponent(workspaceId)}/peons/'
        '${Uri.encodeComponent(peonId)}/projects/'
        '${Uri.encodeComponent(projectKey)}/files/$encodedPath',
        queryParameters: const {'stat': 1, 'directory': 1},
      );
      final payload = response.data;
      final rawEntries = payload?['entries'];
      if (rawEntries is! List) {
        throw const FormatException('Invalid project directory response');
      }
      final entries =
          rawEntries
              .map((item) {
                final json = Map<String, dynamic>.from(item as Map);
                final name = json['name'];
                final type = json['type'];
                if (name is! String || type is! String) {
                  throw const FormatException('Invalid project file entry');
                }
                return ProjectFileEntry(
                  name: name,
                  type: type,
                  size: (json['size'] as num?)?.toInt(),
                  mtimeMs: (json['mtimeMs'] as num?)?.toDouble(),
                );
              })
              .toList(growable: false)
            ..sort((left, right) {
              if (left.isDirectory != right.isDirectory) {
                return left.isDirectory ? -1 : 1;
              }
              return left.name.toLowerCase().compareTo(
                right.name.toLowerCase(),
              );
            });
      return ProjectDirectory(path: path, entries: entries);
    } on DioException catch (error) {
      final data = error.response?.data;
      final message = data is Map<String, dynamic>
          ? data['error'] as String?
          : null;
      throw ProjectsException(message ?? 'Could not load project files.');
    } on FormatException {
      throw const ProjectsException(
        'Overseer returned an invalid project directory.',
      );
    } on TypeError {
      throw const ProjectsException(
        'Overseer returned an invalid project directory.',
      );
    }
  }

  @override
  Future<ProjectFilePreview> fetchFile({
    required String workspaceId,
    required String peonId,
    required String projectKey,
    required String path,
  }) async {
    final encodedPath = path
        .split('/')
        .where((segment) => segment.isNotEmpty)
        .map(Uri.encodeComponent)
        .join('/');
    try {
      final response = await _dio.get<List<int>>(
        'workspaces/${Uri.encodeComponent(workspaceId)}/peons/'
        '${Uri.encodeComponent(peonId)}/projects/'
        '${Uri.encodeComponent(projectKey)}/files/$encodedPath',
        options: Options(responseType: ResponseType.bytes),
      );
      return ProjectFilePreview(
        path: path,
        bytes: Uint8List.fromList(response.data ?? const []),
        contentType: response.headers.value(Headers.contentTypeHeader),
      );
    } on DioException catch (error) {
      throw _projectsException(error, 'Could not open this project file.');
    }
  }

  ProjectsException _projectsException(
    DioException error,
    String fallbackMessage,
  ) {
    final data = error.response?.data;
    final message = data is Map ? data['error'] as String? : null;
    final code = data is Map ? data['code'] as String? : null;
    return ProjectsException(message ?? fallbackMessage, code: code);
  }

  @override
  Future<void> applyLiveProjection({
    required String workspaceId,
    required int cursor,
    required Map<String, dynamic> projection,
  }) async {
    final peonId = projection['peonId'];
    final projectId = projection['projectId'];
    if (peonId is! String || projectId is! String) {
      await advanceCursor(workspaceId: workspaceId, cursor: cursor);
      return;
    }
    final syncedAt = (projection['syncedAt'] as num?)?.toDouble() ?? 0;
    await database.transaction(() async {
      final existing =
          await (database.select(database.cachedProjects)..where(
                (row) =>
                    row.workspaceId.equals(workspaceId) &
                    row.peonId.equals(peonId) &
                    row.projectId.equals(projectId),
              ))
              .getSingleOrNull();
      if (existing != null && existing.syncedAt > syncedAt) {
        await _advanceCursorInTransaction(workspaceId, cursor);
        return;
      }
      if (projection['deleted'] == true) {
        await database
            .into(database.cachedProjects)
            .insertOnConflictUpdate(
              CachedProjectsCompanion.insert(
                workspaceId: workspaceId,
                peonId: peonId,
                projectId: projectId,
                projectKey: existing?.projectKey ?? '',
                name: Value(existing?.name),
                dir: Value(existing?.dir),
                metadata: Value(existing?.metadata),
                sessionCount: Value(existing?.sessionCount ?? 0),
                memberCount: Value(existing?.memberCount ?? 0),
                activeCount: Value(existing?.activeCount ?? 0),
                lastActivityMs: Value(existing?.lastActivityMs),
                syncedAt: Value(syncedAt),
                deleted: const Value(true),
              ),
            );
      } else if (projection['key'] is String) {
        final project = _domainFromJson(workspaceId, peonId, projection);
        await database
            .into(database.cachedProjects)
            .insert(
              _companion(project),
              onConflict: DoUpdate(
                (_) => _companion(project),
                where: (old) =>
                    old.syncedAt.isSmallerThanValue(project.syncedAt) |
                    (old.syncedAt.equals(project.syncedAt) &
                        old.deleted.equals(false)),
              ),
            );
      }
      await _advanceCursorInTransaction(workspaceId, cursor);
    });
  }

  @override
  Future<void> advanceCursor({
    required String workspaceId,
    required int cursor,
  }) => database.transaction(
    () => _advanceCursorInTransaction(workspaceId, cursor),
  );

  Future<void> _advanceCursorInTransaction(
    String workspaceId,
    int cursor,
  ) async {
    if (cursor <= 0) return;
    await database
        .into(database.liveCursors)
        .insert(
          LiveCursorsCompanion.insert(
            workspaceId: workspaceId,
            cursor: Value(cursor),
          ),
          onConflict: DoUpdate(
            (_) => LiveCursorsCompanion(cursor: Value(cursor)),
            where: (old) => old.cursor.isSmallerThanValue(cursor),
          ),
        );
  }

  @override
  Future<int> cursorFor(String workspaceId) async {
    final row = await (database.select(
      database.liveCursors,
    )..where((row) => row.workspaceId.equals(workspaceId))).getSingleOrNull();
    return row?.cursor ?? 0;
  }

  PeonProject _domainFromJson(
    String workspaceId,
    String peonId,
    Map<String, dynamic> json,
  ) {
    final projectId = json['projectId'] as String?;
    final key = json['key'] as String;
    return PeonProject(
      workspaceId: workspaceId,
      peonId: peonId,
      projectId: projectId ?? 'legacy:$key',
      key: key,
      name: (json['name'] ?? json['label']) as String?,
      dir: (json['dir'] ?? json['path']) as String?,
      metadata: json['metadata'] as String?,
      sessionCount: (json['sessionCount'] as num?)?.toInt() ?? 0,
      memberCount: (json['memberCount'] as num?)?.toInt() ?? 0,
      activeCount: (json['activeCount'] as num?)?.toInt() ?? 0,
      lastActivityMs: (json['lastActivityMs'] as num?)?.toDouble(),
      syncedAt: (json['syncedAt'] as num?)?.toDouble() ?? 0,
      deleted: json['deleted'] as bool? ?? false,
    );
  }

  PeonProject _domainFromRow(CachedProject row) {
    return PeonProject(
      workspaceId: row.workspaceId,
      peonId: row.peonId,
      projectId: row.projectId,
      key: row.projectKey,
      name: row.name,
      dir: row.dir,
      metadata: row.metadata,
      sessionCount: row.sessionCount,
      memberCount: row.memberCount,
      activeCount: row.activeCount,
      lastActivityMs: row.lastActivityMs,
      syncedAt: row.syncedAt,
      deleted: row.deleted,
    );
  }

  CachedProjectsCompanion _companion(PeonProject project) {
    return CachedProjectsCompanion.insert(
      workspaceId: project.workspaceId,
      peonId: project.peonId,
      projectId: project.projectId,
      projectKey: project.key,
      name: Value(project.name),
      dir: Value(project.dir),
      metadata: Value(project.metadata),
      sessionCount: Value(project.sessionCount),
      memberCount: Value(project.memberCount),
      activeCount: Value(project.activeCount),
      lastActivityMs: Value(project.lastActivityMs),
      syncedAt: Value(project.syncedAt),
      deleted: Value(project.deleted),
    );
  }

  List<PeonProject> _sorted(Iterable<PeonProject> projects) {
    final result = projects.toList(growable: false);
    result.sort(
      (a, b) =>
          a.displayName.toLowerCase().compareTo(b.displayName.toLowerCase()),
    );
    return result;
  }
}
