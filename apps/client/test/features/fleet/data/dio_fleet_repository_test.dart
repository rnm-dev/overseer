import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/database/app_database.dart';
import 'package:overseer_mobile/features/fleet/data/dio_fleet_repository.dart';

void main() {
  test('persists and watches the workspace and Peon fleet', () async {
    final database = AppDatabase.forTesting(NativeDatabase.memory());
    addTearDown(database.close);
    final adapter = _FleetAdapter();
    final dio = Dio(BaseOptions(baseUrl: 'https://overseer.example/api/v1/'))
      ..httpClientAdapter = adapter;
    final repository = DioFleetRepository(database: database, dio: dio);

    final refreshed = await repository.refreshFleet();
    expect(refreshed.single.workspace.name, 'Workspace One');
    expect(refreshed.single.peons.single.displayName, 'Peon One');

    final cached = await repository.loadCachedFleet();
    expect(cached.single.workspace.id, 'workspace-1');
    expect(cached.single.peons.single.online, isFalse);
    expect(cached.single.peons.single.capabilities, ['codex']);
    expect(cached.single.peons.single.recentSessions, hasLength(1));
    expect(
      cached.single.peons.single.recentSessions.single.displayTitle,
      'Waiting session',
    );
    expect(
      cached.single.peons.single.recentSessions.single.hasOutstandingRequest,
      isTrue,
    );
    expect(adapter.peonRequest?.queryParameters, {
      'includeRecentSessions': 'mine',
      'recentSessionsLimit': 10,
    });

    final onlineFleet = repository.watchFleet().firstWhere(
      (fleet) => fleet.single.peons.single.online,
    );
    await repository.applyPeonProjection(
      workspaceId: 'workspace-1',
      cursor: 1,
      projection: const {
        'peonId': 'peon-1',
        'online': true,
        'name': 'Updated Peon',
      },
    );

    final updated = await onlineFleet;
    expect(updated.single.peons.single.displayName, 'Updated Peon');
    expect(updated.single.peons.single.online, isTrue);
  });

  test(
    'stale Peon projection cannot regress a row but checkpoints its cursor',
    () async {
      final database = AppDatabase.forTesting(NativeDatabase.memory());
      addTearDown(database.close);
      final repository = DioFleetRepository(database: database, dio: Dio());
      await database
          .into(database.cachedWorkspaces)
          .insert(
            CachedWorkspacesCompanion.insert(
              workspaceId: 'workspace-1',
              name: 'Workspace',
              syncedAt: 1,
            ),
          );
      await database
          .into(database.cachedFleetPeons)
          .insert(
            CachedFleetPeonsCompanion.insert(
              workspaceId: 'workspace-1',
              peonId: 'peon-1',
              online: false,
              lastSeen: 0,
              syncedAt: 1,
            ),
          );

      await repository.applyPeonProjection(
        workspaceId: 'workspace-1',
        cursor: 10,
        projection: const {
          'peonId': 'peon-1',
          'syncedAt': 10,
          'name': 'Current',
          'online': true,
        },
      );
      await repository.applyPeonProjection(
        workspaceId: 'workspace-1',
        cursor: 11,
        projection: const {
          'peonId': 'peon-1',
          'syncedAt': 9,
          'name': 'Stale',
          'online': false,
        },
      );

      final row = await (database.select(
        database.cachedFleetPeons,
      )..where((row) => row.workspaceId.equals('workspace-1'))).getSingle();
      expect(row.name, 'Current');
      expect(row.online, isTrue);
      final cursor = await (database.select(
        database.liveCursors,
      )..where((row) => row.workspaceId.equals('workspace-1'))).getSingle();
      expect(cursor.cursor, 11);
    },
  );
}

class _FleetAdapter implements HttpClientAdapter {
  RequestOptions? peonRequest;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    if (options.path.endsWith('workspaces')) {
      return _jsonResponse({
        'workspaces': [
          {'id': 'workspace-1', 'name': 'Workspace One', 'role': 'owner'},
        ],
      });
    }
    if (options.path.endsWith('workspaces/workspace-1/peons')) {
      peonRequest = options;
      return _jsonResponse({
        'peons': [
          {
            'peonId': 'peon-1',
            'name': 'Peon One',
            'online': false,
            'lastSeen': 12,
            'capabilities': ['codex'],
            'load': {'activeSessions': 2, 'paused': false},
            'recentSessions': [
              {
                'sessionId': 'session-1',
                'title': 'Waiting session',
                'status': 'running',
                'lastActivityAt': 100,
                'syncedAt': 100,
                'lastRequestedAt': 95,
                'attentionUpdatedAt': 95,
                'hasOutstandingRequest': true,
                'attentionUnread': false,
              },
            ],
          },
        ],
      });
    }
    throw StateError('Unexpected request: ${options.method} ${options.path}');
  }

  ResponseBody _jsonResponse(Map<String, dynamic> body) {
    return ResponseBody.fromString(
      jsonEncode(body),
      HttpStatus.ok,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}
