import 'package:drift/drift.dart';

import '../../../core/database/app_database.dart';

Future<void> applyAuthoritativeProjectSessionCounts({
  required AppDatabase database,
  required String workspaceId,
  required String peonId,
  required Object? rawCounts,
}) async {
  if (rawCounts is! List) return;
  for (final raw in rawCounts) {
    if (raw is! Map) continue;
    final projectId = raw['projectId'];
    final projectKey = raw['projectKey'];
    final sessionCount = raw['sessionCount'];
    if (projectKey is! String ||
        sessionCount is! num ||
        sessionCount.toInt() != sessionCount ||
        sessionCount < 0) {
      continue;
    }
    final query = database.select(database.cachedProjects)
      ..where(
        (row) =>
            row.workspaceId.equals(workspaceId) &
            row.peonId.equals(peonId) &
            (projectId is String
                ? row.projectId.equals(projectId)
                : row.projectKey.equals(projectKey)),
      );
    final projects = await query.get();
    for (final project in projects) {
      final nextCount = sessionCount.toInt();
      if (project.sessionCount == nextCount) continue;
      await (database.update(database.cachedProjects)..where(
            (row) =>
                row.workspaceId.equals(project.workspaceId) &
                row.peonId.equals(project.peonId) &
                row.projectId.equals(project.projectId),
          ))
          .write(
            CachedProjectsCompanion(sessionCount: Value(nextCount)),
          );
    }
  }
}

Future<void> adjustCachedProjectSessionCount({
  required AppDatabase database,
  required String workspaceId,
  required String peonId,
  required String? projectId,
  required String? projectKey,
  required int delta,
}) async {
  if (delta == 0 || (projectId == null && projectKey == null)) return;
  final query = database.select(database.cachedProjects)
    ..where(
      (row) =>
          row.workspaceId.equals(workspaceId) &
          row.peonId.equals(peonId) &
          (projectId != null
              ? row.projectId.equals(projectId)
              : row.projectKey.equals(projectKey!)),
    );
  final rows = await query.get();
  for (final project in rows) {
    await (database.update(database.cachedProjects)..where(
          (row) =>
              row.workspaceId.equals(project.workspaceId) &
              row.peonId.equals(project.peonId) &
              row.projectId.equals(project.projectId),
        ))
        .write(
          CachedProjectsCompanion(
            sessionCount: Value(
              (project.sessionCount + delta).clamp(0, 0x7fffffff).toInt(),
            ),
          ),
        );
  }
}
