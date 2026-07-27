import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/database/app_database.dart';

void main() {
  group('AppDatabase migrations', () {
    for (var version = 1; version < 12; version++) {
      test('migrates schema v$version to v12 without losing data', () async {
        final database = AppDatabase.forTesting(
          NativeDatabase.memory(
            setup: (sqlite) {
              void execute(String statement) => sqlite.execute(statement);
              _createSchemaAtVersion(execute, version);
              _seedSchemaAtVersion(execute, version);
              execute('PRAGMA user_version = $version');
            },
          ),
        );
        addTearDown(database.close);

        // Opening the database runs the migration.
        expect(
          await database.customSelect('PRAGMA user_version').getSingle(),
          predicate<QueryRow>((row) => row.read<int>('user_version') == 12),
        );

        expect(await _tableNames(database), containsAll(_tablesAtVersion(12)));
        expect(
          await _columnNames(database, 'cached_sessions'),
          containsAll(<String>{
            'operator_requested',
            'has_outstanding_request',
            'last_requested_at',
          }),
        );
        expect(
          await _columnNames(database, 'pending_followup_commands'),
          containsAll(<String>{
            'agent',
            'model',
            'reasoning_effort',
            'attachments_json',
          }),
        );

        for (final table in _tablesAtVersion(version)) {
          final marker = await database
              .customSelect(
                'SELECT marker FROM migration_markers '
                'WHERE table_name = ?',
                variables: [Variable<String>(table)],
              )
              .getSingle();
          expect(marker.read<String>('marker'), 'preserved-v$version');
          expect(
            await database
                .customSelect('SELECT COUNT(*) AS count FROM $table')
                .getSingle()
                .then((row) => row.read<int>('count')),
            1,
            reason: 'The existing row in $table should survive v$version → v12',
          );
        }

        if (version >= 5) {
          final command = await database
              .customSelect(
                'SELECT prompt, agent, model, reasoning_effort, attachments_json '
                'FROM pending_followup_commands',
              )
              .getSingle();
          expect(command.read<String>('prompt'), 'keep this follow-up');
          expect(
            command.readNullable<String>('agent'),
            version >= 7 ? 'codex' : null,
          );
          expect(
            command.readNullable<String>('model'),
            version >= 6 ? 'model-v$version' : null,
          );
          expect(
            command.readNullable<String>('reasoning_effort'),
            version >= 6 ? 'high' : null,
          );
          expect(
            command.read<String>('attachments_json'),
            version >= 9 ? '["attachment"]' : '[]',
          );
        }
      });
    }

    test('creates the complete v12 schema from an empty database', () async {
      final database = AppDatabase.forTesting(NativeDatabase.memory());
      addTearDown(database.close);

      expect(await _tableNames(database), containsAll(_tablesAtVersion(12)));
      expect(
        await _columnNames(database, 'cached_sessions'),
        containsAll(<String>{
          'attention_unread',
          'attention_updated_at',
          'operator_requested',
          'has_outstanding_request',
          'last_requested_at',
        }),
      );
      expect(
        await _columnNames(database, 'pending_followup_commands'),
        containsAll(<String>{
          'start_now',
          'agent',
          'model',
          'reasoning_effort',
          'attachments_json',
        }),
      );
    });
  });
}

Future<Set<String>> _tableNames(AppDatabase database) async {
  final rows = await database
      .customSelect("SELECT name FROM sqlite_master WHERE type = 'table'")
      .get();
  return rows.map((row) => row.read<String>('name')).toSet();
}

Future<Set<String>> _columnNames(AppDatabase database, String table) async {
  final rows = await database.customSelect('PRAGMA table_info($table)').get();
  return rows.map((row) => row.read<String>('name')).toSet();
}

Set<String> _tablesAtVersion(int version) => <String>{
  'cached_sessions',
  'live_cursors',
  if (version >= 2) 'cached_projects',
  if (version >= 3) 'cached_ai_stats',
  if (version >= 4) ...<String>{
    'cached_transcript_events',
    'cached_transcripts',
  },
  if (version >= 5) ...<String>{'composer_drafts', 'pending_followup_commands'},
  if (version >= 8) 'cached_queued_followups',
  if (version >= 10) 'cached_peon_management',
  if (version >= 11) ...<String>{'cached_workspaces', 'cached_fleet_peons'},
};

void _createSchemaAtVersion(
  void Function(String statement) execute,
  int version,
) {
  execute('''
    CREATE TABLE cached_sessions (
      workspace_id TEXT NOT NULL,
      peon_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT,
      project_key TEXT,
      project_id TEXT,
      title TEXT,
      prompt_preview TEXT,
      preview TEXT,
      author TEXT,
      outcome_json TEXT,
      started_at REAL,
      ended_at REAL,
      last_activity_at REAL,
      synced_at REAL NOT NULL,
      attention_unread INTEGER NOT NULL DEFAULT 0,
      attention_updated_at REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (workspace_id, peon_id, session_id)
    )
  ''');
  execute('''
    CREATE TABLE live_cursors (
      workspace_id TEXT NOT NULL PRIMARY KEY,
      cursor INTEGER NOT NULL DEFAULT 0
    )
  ''');

  if (version >= 2) {
    execute('''
      CREATE TABLE cached_projects (
        workspace_id TEXT NOT NULL,
        peon_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_key TEXT NOT NULL,
        name TEXT,
        dir TEXT,
        metadata TEXT,
        session_count INTEGER NOT NULL DEFAULT 0,
        member_count INTEGER NOT NULL DEFAULT 0,
        active_count INTEGER NOT NULL DEFAULT 0,
        last_activity_ms REAL,
        synced_at REAL NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (workspace_id, peon_id, project_id)
      )
    ''');
  }
  if (version >= 3) {
    execute('''
      CREATE TABLE cached_ai_stats (
        workspace_id TEXT NOT NULL,
        peon_id TEXT NOT NULL,
        period TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at REAL NOT NULL,
        PRIMARY KEY (workspace_id, peon_id, period)
      )
    ''');
  }
  if (version >= 4) {
    execute('''
      CREATE TABLE cached_transcript_events (
        workspace_id TEXT NOT NULL,
        peon_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        order_key INTEGER NOT NULL,
        event_type TEXT,
        payload_json TEXT NOT NULL,
        created_at REAL,
        updated_at REAL NOT NULL,
        PRIMARY KEY (workspace_id, peon_id, session_id, event_id)
      )
    ''');
    execute('''
      CREATE TABLE cached_transcripts (
        workspace_id TEXT NOT NULL,
        peon_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        has_older INTEGER NOT NULL DEFAULT 0,
        synced_at REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (workspace_id, peon_id, session_id)
      )
    ''');
  }
  if (version >= 5) {
    execute('''
      CREATE TABLE composer_drafts (
        workspace_id TEXT NOT NULL,
        peon_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        draft_text TEXT NOT NULL,
        updated_at REAL NOT NULL,
        PRIMARY KEY (workspace_id, peon_id, session_id)
      )
    ''');
    execute('''
      CREATE TABLE pending_followup_commands (
        command_id TEXT NOT NULL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        peon_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        server_queue INTEGER NOT NULL,
        start_now INTEGER NOT NULL DEFAULT 0,
        ${version >= 7 ? 'agent TEXT,' : ''}
        ${version >= 6 ? 'model TEXT, reasoning_effort TEXT,' : ''}
        ${version >= 9 ? "attachments_json TEXT NOT NULL DEFAULT '[]'," : ''}
        created_at REAL NOT NULL
      )
    ''');
  }
  if (version >= 8) {
    execute('''
      CREATE TABLE cached_queued_followups (
        workspace_id TEXT NOT NULL,
        peon_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        order_key INTEGER NOT NULL,
        synced_at REAL NOT NULL,
        PRIMARY KEY (workspace_id, peon_id, session_id, item_id)
      )
    ''');
  }
  if (version >= 10) {
    execute('''
      CREATE TABLE cached_peon_management (
        workspace_id TEXT NOT NULL,
        peon_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at REAL NOT NULL,
        PRIMARY KEY (workspace_id, peon_id, kind)
      )
    ''');
  }
  if (version >= 11) {
    execute('''
      CREATE TABLE cached_workspaces (
        workspace_id TEXT NOT NULL PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT,
        synced_at REAL NOT NULL
      )
    ''');
    execute('''
      CREATE TABLE cached_fleet_peons (
        workspace_id TEXT NOT NULL,
        peon_id TEXT NOT NULL,
        name TEXT,
        hostname TEXT,
        base_url TEXT,
        address_source TEXT,
        online INTEGER NOT NULL,
        last_seen REAL NOT NULL,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        active_sessions INTEGER,
        paused INTEGER,
        synced_at REAL NOT NULL,
        PRIMARY KEY (workspace_id, peon_id)
      )
    ''');
  }

  execute('''
    CREATE TABLE migration_markers (
      table_name TEXT NOT NULL PRIMARY KEY,
      marker TEXT NOT NULL
    )
  ''');
}

void _seedSchemaAtVersion(
  void Function(String statement) execute,
  int version,
) {
  execute('''
    INSERT INTO cached_sessions (
      workspace_id, peon_id, session_id, title, synced_at
    ) VALUES ('workspace', 'peon', 'session', 'preserve me', 1)
  ''');
  execute("INSERT INTO live_cursors VALUES ('workspace', 42)");

  if (version >= 2) {
    execute('''
      INSERT INTO cached_projects (
        workspace_id, peon_id, project_id, project_key, name
      ) VALUES ('workspace', 'peon', 'project', 'key', 'preserve me')
    ''');
  }
  if (version >= 3) {
    execute('''
      INSERT INTO cached_ai_stats
      VALUES ('workspace', 'peon', 'week', '{}', 1)
    ''');
  }
  if (version >= 4) {
    execute('''
      INSERT INTO cached_transcript_events (
        workspace_id, peon_id, session_id, event_id, order_key,
        payload_json, updated_at
      ) VALUES ('workspace', 'peon', 'session', 'event', 1, '{}', 1)
    ''');
    execute('''
      INSERT INTO cached_transcripts (
        workspace_id, peon_id, session_id
      ) VALUES ('workspace', 'peon', 'session')
    ''');
  }
  if (version >= 5) {
    execute('''
      INSERT INTO composer_drafts
      VALUES ('workspace', 'peon', 'session', 'preserve me', 1)
    ''');
    execute('''
      INSERT INTO pending_followup_commands (
        command_id, workspace_id, peon_id, session_id, prompt, server_queue,
        start_now, ${version >= 7 ? 'agent,' : ''}
        ${version >= 6 ? 'model, reasoning_effort,' : ''}
        ${version >= 9 ? 'attachments_json,' : ''} created_at
      ) VALUES (
        'command', 'workspace', 'peon', 'session', 'keep this follow-up', 1, 0,
        ${version >= 7 ? "'codex'," : ''}
        ${version >= 6 ? "'model-v$version', 'high'," : ''}
        ${version >= 9 ? """'["attachment"]',""" : ''} 1
      )
    ''');
  }
  if (version >= 8) {
    execute('''
      INSERT INTO cached_queued_followups
      VALUES ('workspace', 'peon', 'session', 'item', '{}', 1, 1)
    ''');
  }
  if (version >= 10) {
    execute('''
      INSERT INTO cached_peon_management
      VALUES ('workspace', 'peon', 'general', '{}', 1)
    ''');
  }
  if (version >= 11) {
    execute('''
      INSERT INTO cached_workspaces
      VALUES ('workspace', 'Workspace', 'owner', 1)
    ''');
    execute('''
      INSERT INTO cached_fleet_peons (
        workspace_id, peon_id, name, online, last_seen, synced_at
      ) VALUES ('workspace', 'peon', 'Peon', 1, 1, 1)
    ''');
  }

  for (final table in _tablesAtVersion(version)) {
    execute(
      "INSERT INTO migration_markers VALUES "
      "('$table', 'preserved-v$version')",
    );
  }
}
