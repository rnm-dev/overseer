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
    final dio = Dio(BaseOptions(baseUrl: 'https://overseer.example/api/v1/'))
      ..httpClientAdapter = _FleetAdapter();
    final repository = DioFleetRepository(
      database: database,
      apiUrl: Uri.parse('https://overseer.example/api/v1/'),
      token: 'token',
      dio: dio,
    );

    final refreshed = await repository.refreshFleet();
    expect(refreshed.single.workspace.name, 'Workspace One');
    expect(refreshed.single.peons.single.displayName, 'Peon One');

    final cached = await repository.loadCachedFleet();
    expect(cached.single.workspace.id, 'workspace-1');
    expect(cached.single.peons.single.online, isFalse);
    expect(cached.single.peons.single.capabilities, ['codex']);

    final onlineFleet = repository.watchFleet().firstWhere(
      (fleet) => fleet.single.peons.single.online,
    );
    await repository.applyPeonProjection(
      workspaceId: 'workspace-1',
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
}

class _FleetAdapter implements HttpClientAdapter {
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
      return _jsonResponse({
        'peons': [
          {
            'peonId': 'peon-1',
            'name': 'Peon One',
            'online': false,
            'lastSeen': 12,
            'capabilities': ['codex'],
            'load': {'activeSessions': 2, 'paused': false},
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
