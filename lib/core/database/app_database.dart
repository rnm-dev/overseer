import 'package:drift/drift.dart';
import 'package:drift_flutter/drift_flutter.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

part 'app_database.g.dart';

final appDatabaseProvider = Provider<AppDatabase>((ref) {
  final database = AppDatabase();
  ref.onDispose(database.close);
  return database;
});

class CachedSessions extends Table {
  TextColumn get workspaceId => text()();
  TextColumn get peonId => text()();
  TextColumn get sessionId => text()();
  TextColumn get status => text().nullable()();
  TextColumn get projectKey => text().nullable()();
  TextColumn get projectId => text().nullable()();
  TextColumn get title => text().nullable()();
  TextColumn get promptPreview => text().nullable()();
  TextColumn get preview => text().nullable()();
  TextColumn get author => text().nullable()();
  TextColumn get outcomeJson => text().nullable()();
  RealColumn get startedAt => real().nullable()();
  RealColumn get endedAt => real().nullable()();
  RealColumn get lastActivityAt => real().nullable()();
  RealColumn get syncedAt => real()();
  BoolColumn get attentionUnread =>
      boolean().withDefault(const Constant(false))();
  RealColumn get attentionUpdatedAt => real().withDefault(const Constant(0))();
  BoolColumn get operatorRequested =>
      boolean().withDefault(const Constant(false))();
  BoolColumn get hasOutstandingRequest =>
      boolean().withDefault(const Constant(false))();
  RealColumn get lastRequestedAt => real().nullable()();

  @override
  Set<Column<Object>> get primaryKey => {workspaceId, peonId, sessionId};
}

class LiveCursors extends Table {
  TextColumn get workspaceId => text()();
  IntColumn get cursor => integer().withDefault(const Constant(0))();

  @override
  Set<Column<Object>> get primaryKey => {workspaceId};
}

class CachedWorkspaces extends Table {
  TextColumn get workspaceId => text()();
  TextColumn get name => text()();
  TextColumn get role => text().nullable()();
  RealColumn get syncedAt => real()();

  @override
  Set<Column<Object>> get primaryKey => {workspaceId};
}

class CachedFleetPeons extends Table {
  TextColumn get workspaceId => text()();
  TextColumn get peonId => text()();
  TextColumn get name => text().nullable()();
  TextColumn get hostname => text().nullable()();
  TextColumn get baseUrl => text().nullable()();
  TextColumn get addressSource => text().nullable()();
  BoolColumn get online => boolean()();
  RealColumn get lastSeen => real()();
  TextColumn get capabilitiesJson => text().withDefault(const Constant('[]'))();
  IntColumn get activeSessions => integer().nullable()();
  BoolColumn get paused => boolean().nullable()();
  RealColumn get syncedAt => real()();

  @override
  Set<Column<Object>> get primaryKey => {workspaceId, peonId};
}

class CachedProjects extends Table {
  TextColumn get workspaceId => text()();
  TextColumn get peonId => text()();
  TextColumn get projectId => text()();
  TextColumn get projectKey => text()();
  TextColumn get name => text().nullable()();
  TextColumn get dir => text().nullable()();
  TextColumn get metadata => text().nullable()();
  IntColumn get sessionCount => integer().withDefault(const Constant(0))();
  IntColumn get memberCount => integer().withDefault(const Constant(0))();
  IntColumn get activeCount => integer().withDefault(const Constant(0))();
  RealColumn get lastActivityMs => real().nullable()();
  RealColumn get syncedAt => real().withDefault(const Constant(0))();
  BoolColumn get deleted => boolean().withDefault(const Constant(false))();

  @override
  Set<Column<Object>> get primaryKey => {workspaceId, peonId, projectId};
}

class CachedAiStats extends Table {
  TextColumn get workspaceId => text()();
  TextColumn get peonId => text()();
  TextColumn get period => text()();
  TextColumn get payloadJson => text()();
  RealColumn get updatedAt => real()();

  @override
  Set<Column<Object>> get primaryKey => {workspaceId, peonId, period};
}

class CachedPeonManagement extends Table {
  TextColumn get workspaceId => text()();
  TextColumn get peonId => text()();
  TextColumn get kind => text()();
  TextColumn get payloadJson => text()();
  RealColumn get updatedAt => real()();

  @override
  Set<Column<Object>> get primaryKey => {workspaceId, peonId, kind};
}

class CachedTranscriptEvents extends Table {
  TextColumn get workspaceId => text()();
  TextColumn get peonId => text()();
  TextColumn get sessionId => text()();
  TextColumn get eventId => text()();
  IntColumn get orderKey => integer()();
  TextColumn get eventType => text().nullable()();
  TextColumn get payloadJson => text()();
  RealColumn get createdAt => real().nullable()();
  RealColumn get updatedAt => real()();

  @override
  Set<Column<Object>> get primaryKey => {
    workspaceId,
    peonId,
    sessionId,
    eventId,
  };
}

class CachedTranscripts extends Table {
  TextColumn get workspaceId => text()();
  TextColumn get peonId => text()();
  TextColumn get sessionId => text()();
  BoolColumn get hasOlder => boolean().withDefault(const Constant(false))();
  RealColumn get syncedAt => real().withDefault(const Constant(0))();

  @override
  Set<Column<Object>> get primaryKey => {workspaceId, peonId, sessionId};
}

class ComposerDrafts extends Table {
  TextColumn get workspaceId => text()();
  TextColumn get peonId => text()();
  TextColumn get sessionId => text()();
  TextColumn get draftText => text()();
  RealColumn get updatedAt => real()();

  @override
  Set<Column<Object>> get primaryKey => {workspaceId, peonId, sessionId};
}

class PendingFollowupCommands extends Table {
  TextColumn get commandId => text()();
  TextColumn get workspaceId => text()();
  TextColumn get peonId => text()();
  TextColumn get sessionId => text()();
  TextColumn get prompt => text()();
  BoolColumn get serverQueue => boolean()();
  BoolColumn get startNow => boolean().withDefault(const Constant(false))();
  TextColumn get agent => text().nullable()();
  TextColumn get model => text().nullable()();
  TextColumn get reasoningEffort => text().nullable()();
  TextColumn get attachmentsJson => text().withDefault(const Constant('[]'))();
  RealColumn get createdAt => real()();

  @override
  Set<Column<Object>> get primaryKey => {commandId};
}

class CachedQueuedFollowups extends Table {
  TextColumn get workspaceId => text()();
  TextColumn get peonId => text()();
  TextColumn get sessionId => text()();
  TextColumn get itemId => text()();
  TextColumn get payloadJson => text()();
  IntColumn get orderKey => integer()();
  RealColumn get syncedAt => real()();

  @override
  Set<Column<Object>> get primaryKey => {
    workspaceId,
    peonId,
    sessionId,
    itemId,
  };
}

@DriftDatabase(
  tables: [
    CachedSessions,
    CachedWorkspaces,
    CachedFleetPeons,
    CachedProjects,
    CachedAiStats,
    CachedPeonManagement,
    LiveCursors,
    CachedTranscriptEvents,
    CachedTranscripts,
    ComposerDrafts,
    PendingFollowupCommands,
    CachedQueuedFollowups,
  ],
)
class AppDatabase extends _$AppDatabase {
  AppDatabase({String name = 'overseer_mobile'})
    : super(driftDatabase(name: name));

  AppDatabase.forTesting(super.executor);

  @override
  int get schemaVersion => 12;

  @override
  MigrationStrategy get migration => MigrationStrategy(
    onCreate: (migrator) => migrator.createAll(),
    onUpgrade: (migrator, from, to) async {
      if (from < 2) {
        await migrator.createTable(cachedProjects);
      }
      if (from < 3) {
        await migrator.createTable(cachedAiStats);
      }
      if (from < 4) {
        await migrator.createTable(cachedTranscriptEvents);
        await migrator.createTable(cachedTranscripts);
      }
      if (from < 5) {
        await migrator.createTable(composerDrafts);
        await migrator.createTable(pendingFollowupCommands);
      }
      if (from == 5) {
        await migrator.addColumn(
          pendingFollowupCommands,
          pendingFollowupCommands.model,
        );
        await migrator.addColumn(
          pendingFollowupCommands,
          pendingFollowupCommands.reasoningEffort,
        );
      }
      if (from >= 5 && from < 7) {
        await migrator.addColumn(
          pendingFollowupCommands,
          pendingFollowupCommands.agent,
        );
      }
      if (from < 8) {
        await migrator.createTable(cachedQueuedFollowups);
      }
      if (from >= 5 && from < 9) {
        await migrator.addColumn(
          pendingFollowupCommands,
          pendingFollowupCommands.attachmentsJson,
        );
      }
      if (from < 10) {
        await migrator.createTable(cachedPeonManagement);
      }
      if (from < 11) {
        await migrator.createTable(cachedWorkspaces);
        await migrator.createTable(cachedFleetPeons);
      }
      if (from < 12) {
        await migrator.addColumn(
          cachedSessions,
          cachedSessions.operatorRequested,
        );
        await migrator.addColumn(
          cachedSessions,
          cachedSessions.hasOutstandingRequest,
        );
        await migrator.addColumn(
          cachedSessions,
          cachedSessions.lastRequestedAt,
        );
      }
    },
  );
}
