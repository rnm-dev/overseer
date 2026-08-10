import 'package:drift/drift.dart';

import '../database/app_database.dart';

/// Commits a resource projection and its workspace delivery frontier together.
///
/// Callers supply only domain-row work; this helper owns the shared cursor
/// checkpoint so a crash either replays the event or exposes all of its rows.
final class DurableProjectionTransaction {
  const DurableProjectionTransaction(this.database);

  final AppDatabase database;

  Future<void> commit({
    required String workspaceId,
    required int cursor,
    required Future<void> Function() write,
  }) => database.transaction(() async {
    await write();
    await advanceInTransaction(workspaceId: workspaceId, cursor: cursor);
  });

  Future<void> advance({required String workspaceId, required int cursor}) =>
      commit(workspaceId: workspaceId, cursor: cursor, write: () async {});

  Future<void> advanceInTransaction({
    required String workspaceId,
    required int cursor,
  }) async {
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

  Future<int> cursorFor(String workspaceId) async {
    final row = await (database.select(
      database.liveCursors,
    )..where((row) => row.workspaceId.equals(workspaceId))).getSingleOrNull();
    return row?.cursor ?? 0;
  }
}
