import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:drift/drift.dart';

import '../../../core/database/app_database.dart';
import '../../../core/network/overseer_http_client.dart';
import '../domain/fleet_models.dart';
import '../domain/fleet_repository.dart';

class DioFleetRepository implements CachedFleetRepository {
  DioFleetRepository({
    required this._database,
    required Uri apiUrl,
    required String token,
    Dio? dio,
  }) : _dio = dio ?? createOverseerHttpClient(apiUrl: apiUrl, token: token);

  final AppDatabase _database;
  final Dio _dio;

  @override
  Future<List<WorkspaceFleet>> loadFleet() => refreshFleet();

  @override
  Future<List<WorkspaceFleet>> loadCachedFleet() => _readCachedFleet();

  @override
  Stream<List<WorkspaceFleet>> watchFleet() {
    final query = _database.select(_database.cachedWorkspaces).join([
      leftOuterJoin(
        _database.cachedFleetPeons,
        _database.cachedFleetPeons.workspaceId.equalsExp(
          _database.cachedWorkspaces.workspaceId,
        ),
      ),
    ]);
    return query.watch().asyncMap((_) => _readCachedFleet());
  }

  @override
  Future<List<WorkspaceFleet>> refreshFleet() async {
    try {
      final workspaceResponse = await _dio.get<Map<String, dynamic>>(
        'workspaces',
      );
      final workspaceJson = _list(workspaceResponse.data, 'workspaces');
      final workspaces = workspaceJson.map(_workspaceFromJson).toList();
      final peonLists = await Future.wait(
        workspaces.map((workspace) async {
          final response = await _dio.get<Map<String, dynamic>>(
            'workspaces/${Uri.encodeComponent(workspace.id)}/peons',
          );
          return _list(response.data, 'peons').map(_peonFromJson).toList();
        }),
      );

      final fleet = [
        for (var index = 0; index < workspaces.length; index++)
          WorkspaceFleet(workspace: workspaces[index], peons: peonLists[index]),
      ];
      await _replaceCachedFleet(fleet);
      return fleet;
    } on DioException catch (error) {
      final payload = error.response?.data;
      final serverMessage = payload is Map<String, dynamic>
          ? payload['error'] as String?
          : null;
      throw FleetException(
        serverMessage ??
            'Could not reach Overseer. Check your connection and try again.',
      );
    } on FormatException catch (error) {
      throw FleetException(error.message);
    } on TypeError {
      throw const FleetException(
        'Overseer returned an invalid fleet response.',
      );
    }
  }

  @override
  Future<void> applyPeonProjection({
    required String workspaceId,
    required Map<String, dynamic> projection,
  }) async {
    final peonId = projection['peonId'];
    if (peonId is! String || peonId.isEmpty) return;
    final current =
        await (_database.select(_database.cachedFleetPeons)..where(
              (row) =>
                  row.workspaceId.equals(workspaceId) &
                  row.peonId.equals(peonId),
            ))
            .getSingleOrNull();
    if (current == null) return;
    final capabilities = projection['capabilities'];
    final load = projection['load'];
    await (_database.update(_database.cachedFleetPeons)..where(
          (row) =>
              row.workspaceId.equals(workspaceId) & row.peonId.equals(peonId),
        ))
        .write(
          CachedFleetPeonsCompanion(
            name: Value(projection['name'] as String? ?? current.name),
            hostname: Value(
              projection['hostname'] as String? ?? current.hostname,
            ),
            baseUrl: Value(projection['baseUrl'] as String? ?? current.baseUrl),
            addressSource: Value(
              projection['addressSource'] as String? ?? current.addressSource,
            ),
            online: Value(projection['online'] as bool? ?? current.online),
            lastSeen: Value(
              (projection['lastSeen'] as num?)?.toDouble() ?? current.lastSeen,
            ),
            capabilitiesJson: Value(
              capabilities is List
                  ? jsonEncode(capabilities.whereType<String>().toList())
                  : current.capabilitiesJson,
            ),
            activeSessions: Value(
              load is Map<String, dynamic>
                  ? (load['activeSessions'] as num?)?.toInt()
                  : current.activeSessions,
            ),
            paused: Value(
              load is Map<String, dynamic>
                  ? load['paused'] as bool?
                  : current.paused,
            ),
            syncedAt: Value(DateTime.now().millisecondsSinceEpoch.toDouble()),
          ),
        );
  }

  Future<List<WorkspaceFleet>> _readCachedFleet() async {
    final workspaces = await (_database.select(
      _database.cachedWorkspaces,
    )..orderBy([(row) => OrderingTerm.asc(row.name)])).get();
    final peons = await _database.select(_database.cachedFleetPeons).get();
    final peonsByWorkspace = <String, List<Peon>>{};
    for (final row in peons) {
      peonsByWorkspace
          .putIfAbsent(row.workspaceId, () => [])
          .add(_peonFromCache(row));
    }
    for (final items in peonsByWorkspace.values) {
      items.sort(
        (left, right) => left.displayName.toLowerCase().compareTo(
          right.displayName.toLowerCase(),
        ),
      );
    }
    return [
      for (final row in workspaces)
        WorkspaceFleet(
          workspace: Workspace(
            id: row.workspaceId,
            name: row.name,
            role: row.role,
          ),
          peons: peonsByWorkspace[row.workspaceId] ?? const [],
        ),
    ];
  }

  Future<void> _replaceCachedFleet(List<WorkspaceFleet> fleet) async {
    final syncedAt = DateTime.now().millisecondsSinceEpoch.toDouble();
    await _database.transaction(() async {
      await _database.delete(_database.cachedFleetPeons).go();
      await _database.delete(_database.cachedWorkspaces).go();
      for (final item in fleet) {
        await _database
            .into(_database.cachedWorkspaces)
            .insert(
              CachedWorkspacesCompanion.insert(
                workspaceId: item.workspace.id,
                name: item.workspace.name,
                role: Value(item.workspace.role),
                syncedAt: syncedAt,
              ),
            );
        for (final peon in item.peons) {
          await _database
              .into(_database.cachedFleetPeons)
              .insert(
                CachedFleetPeonsCompanion.insert(
                  workspaceId: item.workspace.id,
                  peonId: peon.id,
                  name: Value(peon.name),
                  hostname: Value(peon.hostname),
                  baseUrl: Value(peon.baseUrl),
                  addressSource: Value(peon.addressSource),
                  online: peon.online,
                  lastSeen: peon.lastSeen,
                  capabilitiesJson: Value(jsonEncode(peon.capabilities)),
                  activeSessions: Value(peon.load?.activeSessions),
                  paused: Value(peon.load?.paused),
                  syncedAt: syncedAt,
                ),
              );
        }
      }
    });
  }

  Peon _peonFromCache(CachedFleetPeon row) {
    final capabilities = switch (jsonDecode(row.capabilitiesJson)) {
      final List<dynamic> values => values.whereType<String>().toList(),
      _ => const <String>[],
    };
    final hasLoad = row.activeSessions != null || row.paused != null;
    return Peon(
      id: row.peonId,
      name: row.name,
      hostname: row.hostname,
      baseUrl: row.baseUrl,
      addressSource: row.addressSource,
      online: row.online,
      lastSeen: row.lastSeen,
      capabilities: capabilities,
      load: hasLoad
          ? PeonLoad(activeSessions: row.activeSessions, paused: row.paused)
          : null,
    );
  }

  List<Map<String, dynamic>> _list(Map<String, dynamic>? payload, String key) {
    final value = payload?[key];
    if (value is! List) {
      throw FleetException('Overseer returned an invalid $key response.');
    }
    return value.cast<Map<String, dynamic>>();
  }

  Workspace _workspaceFromJson(Map<String, dynamic> json) {
    return Workspace(
      id: json['id'] as String,
      name: json['name'] as String,
      role: json['role'] as String?,
    );
  }

  Peon _peonFromJson(Map<String, dynamic> json) {
    final loadJson = json['load'];
    return Peon(
      id: json['peonId'] as String,
      name: json['name'] as String?,
      hostname: json['hostname'] as String?,
      baseUrl: json['baseUrl'] as String?,
      addressSource: json['addressSource'] as String?,
      online: json['online'] as bool? ?? false,
      lastSeen: (json['lastSeen'] as num?)?.toDouble() ?? 0,
      capabilities:
          (json['capabilities'] as List?)?.whereType<String>().toList() ??
          const [],
      load: loadJson is Map<String, dynamic>
          ? PeonLoad(
              activeSessions: (loadJson['activeSessions'] as num?)?.toInt(),
              paused: loadJson['paused'] as bool?,
            )
          : null,
    );
  }
}
