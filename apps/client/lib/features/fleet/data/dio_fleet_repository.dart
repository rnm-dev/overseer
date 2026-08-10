import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:drift/drift.dart';

import '../../../core/database/app_database.dart';
import '../../../core/live/resource_projection.dart';
import '../../../core/network/overseer_http_client.dart';
import '../../../core/time/app_time.dart';
import '../domain/fleet_models.dart';
import '../domain/fleet_repository.dart';

class DioFleetRepository implements CachedFleetRepository {
  DioFleetRepository({
    required this._database,
    required Uri apiUrl,
    required String token,
    Dio? dio,
    this._clock = const SystemAppClock(),
  }) : _dio = dio ?? createOverseerHttpClient(apiUrl: apiUrl, token: token);

  final AppDatabase _database;
  final Dio _dio;
  final AppClock _clock;

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
      leftOuterJoin(
        _database.cachedSessions,
        _database.cachedSessions.workspaceId.equalsExp(
              _database.cachedFleetPeons.workspaceId,
            ) &
            _database.cachedSessions.peonId.equalsExp(
              _database.cachedFleetPeons.peonId,
            ) &
            _database.cachedSessions.operatorRequested.equals(true),
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
      final recentSnapshotStartedAt = _clock
          .now()
          .millisecondsSinceEpoch
          .toDouble();
      final peonLists = await Future.wait(
        workspaces.map((workspace) async {
          final response = await _dio.get<Map<String, dynamic>>(
            'workspaces/${Uri.encodeComponent(workspace.id)}/peons',
            queryParameters: const {
              'includeRecentSessions': 'mine',
              'recentSessionsLimit': 10,
            },
          );
          return _list(
            response.data,
            'peons',
          ).map((json) => _peonFromJson(workspace.id, json)).toList();
        }),
      );

      final fleet = [
        for (var index = 0; index < workspaces.length; index++)
          WorkspaceFleet(workspace: workspaces[index], peons: peonLists[index]),
      ];
      await _replaceCachedFleet(
        fleet,
        recentSnapshotStartedAt: recentSnapshotStartedAt,
      );
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
    final envelope = ResourceProjectionEnvelope.peonOwned(
      workspaceId: workspaceId,
      resourceIdKey: 'peonId',
      projection: projection,
    );
    if (envelope == null || envelope.resourceId.isEmpty) return;
    final peonId = envelope.resourceId;
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
            syncedAt: Value(_clock.now().millisecondsSinceEpoch.toDouble()),
          ),
        );
  }

  Future<List<WorkspaceFleet>> _readCachedFleet() async {
    final workspaces = await (_database.select(
      _database.cachedWorkspaces,
    )..orderBy([(row) => OrderingTerm.asc(row.name)])).get();
    final peons = await _database.select(_database.cachedFleetPeons).get();
    final recentSessionRows =
        await (_database.select(_database.cachedSessions)
              ..where((row) => row.operatorRequested.equals(true))
              ..orderBy([
                (row) => OrderingTerm(
                  expression: row.lastActivityAt,
                  mode: OrderingMode.desc,
                  nulls: NullsOrder.last,
                ),
                (row) => OrderingTerm(
                  expression: row.startedAt,
                  mode: OrderingMode.desc,
                  nulls: NullsOrder.last,
                ),
                (row) => OrderingTerm.asc(row.sessionId),
              ]))
            .get();
    final recentByPeon = <String, List<FleetRecentSession>>{};
    for (final row in recentSessionRows) {
      recentByPeon
          .putIfAbsent('${row.workspaceId}\u0000${row.peonId}', () => [])
          .add(_recentSessionFromCache(row));
    }
    final peonsByWorkspace = <String, List<Peon>>{};
    for (final row in peons) {
      peonsByWorkspace
          .putIfAbsent(row.workspaceId, () => [])
          .add(
            _peonFromCache(
              row,
              recentByPeon['${row.workspaceId}\u0000${row.peonId}'] ?? const [],
            ),
          );
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

  Future<void> _replaceCachedFleet(
    List<WorkspaceFleet> fleet, {
    required double recentSnapshotStartedAt,
  }) async {
    final syncedAt = _clock.now().millisecondsSinceEpoch.toDouble();
    final workspaceSnapshot = ResourceSnapshot<WorkspaceFleet>.validated(
      authority: ResourceAuthority.overseer,
      items: fleet,
      identity: (item) => item.workspace.id,
    );
    await _database.transaction(() async {
      await _database.delete(_database.cachedFleetPeons).go();
      await _database.delete(_database.cachedWorkspaces).go();
      for (final item in workspaceSnapshot.items) {
        final peonSnapshot = ResourceSnapshot<Peon>.validated(
          authority: ResourceAuthority.peon,
          items: item.peons,
          identity: (peon) => peon.id,
        );
        await (_database.update(_database.cachedSessions)..where(
              (row) =>
                  row.workspaceId.equals(item.workspace.id) &
                  row.operatorRequested.equals(true) &
                  row.attentionUpdatedAt.isSmallerOrEqualValue(
                    recentSnapshotStartedAt,
                  ),
            ))
            .write(
              const CachedSessionsCompanion(
                operatorRequested: Value(false),
                hasOutstandingRequest: Value(false),
                lastRequestedAt: Value(null),
              ),
            );
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
        for (final peon in peonSnapshot.items) {
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
          for (final session in peon.recentSessions) {
            final canonical = _recentSessionCompanion(session);
            await _database
                .into(_database.cachedSessions)
                .insert(
                  canonical,
                  onConflict: DoUpdate(
                    (_) => canonical,
                    where: (old) =>
                        old.syncedAt.isSmallerOrEqualValue(session.syncedAt),
                  ),
                );
            await (_database.update(_database.cachedSessions)..where(
                  (row) =>
                      row.workspaceId.equals(session.workspaceId) &
                      row.peonId.equals(session.peonId) &
                      row.sessionId.equals(session.sessionId),
                ))
                .write(
                  const CachedSessionsCompanion(operatorRequested: Value(true)),
                );
            await (_database.update(_database.cachedSessions)..where(
                  (row) =>
                      row.workspaceId.equals(session.workspaceId) &
                      row.peonId.equals(session.peonId) &
                      row.sessionId.equals(session.sessionId) &
                      row.attentionUpdatedAt.isSmallerOrEqualValue(
                        session.attentionUpdatedAt,
                      ),
                ))
                .write(
                  CachedSessionsCompanion(
                    hasOutstandingRequest: Value(session.hasOutstandingRequest),
                    attentionUnread: Value(session.attentionUnread),
                    attentionUpdatedAt: Value(session.attentionUpdatedAt),
                    lastRequestedAt: Value(session.lastRequestedAt),
                  ),
                );
          }
        }
      }
    });
  }

  Peon _peonFromCache(
    CachedFleetPeon row,
    List<FleetRecentSession> recentSessions,
  ) {
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
      recentSessions: recentSessions,
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

  Peon _peonFromJson(String workspaceId, Map<String, dynamic> json) {
    final loadJson = json['load'];
    final peonId = json['peonId'] as String;
    final rawRecentSessions = json['recentSessions'];
    return Peon(
      id: peonId,
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
      recentSessions: rawRecentSessions is List
          ? rawRecentSessions
                .map(
                  (value) => _recentSessionFromJson(
                    workspaceId,
                    peonId,
                    Map<String, dynamic>.from(value as Map),
                  ),
                )
                .toList(growable: false)
          : const [],
    );
  }

  FleetRecentSession _recentSessionFromJson(
    String workspaceId,
    String peonId,
    Map<String, dynamic> json,
  ) {
    final sessionId = json['sessionId'] ?? json['id'];
    if (sessionId is! String || sessionId.isEmpty) {
      throw const FormatException('Invalid recent session response');
    }
    final lastRequestedAt = (json['lastRequestedAt'] as num?)?.toDouble();
    return FleetRecentSession(
      workspaceId: workspaceId,
      peonId: peonId,
      sessionId: sessionId,
      status: json['status'] as String?,
      projectKey: json['projectKey'] as String?,
      projectId: json['projectId'] as String?,
      title: json['title'] as String?,
      promptPreview: json['promptPreview'] as String?,
      preview:
          json['preview'] as String? ?? json['lastMessagePreview'] as String?,
      startedAt: (json['startedAt'] as num?)?.toDouble(),
      lastActivityAt: (json['lastActivityAt'] as num?)?.toDouble(),
      syncedAt: (json['syncedAt'] as num?)?.toDouble() ?? 0,
      attentionUpdatedAt:
          (json['attentionUpdatedAt'] as num?)?.toDouble() ??
          lastRequestedAt ??
          0,
      hasOutstandingRequest: json['hasOutstandingRequest'] as bool? ?? false,
      attentionUnread: json['attentionUnread'] as bool? ?? false,
      lastRequestedAt: lastRequestedAt,
    );
  }

  FleetRecentSession _recentSessionFromCache(CachedSession row) {
    return FleetRecentSession(
      workspaceId: row.workspaceId,
      peonId: row.peonId,
      sessionId: row.sessionId,
      status: row.status,
      projectKey: row.projectKey,
      projectId: row.projectId,
      title: row.title,
      promptPreview: row.promptPreview,
      preview: row.preview,
      startedAt: row.startedAt,
      lastActivityAt: row.lastActivityAt,
      syncedAt: row.syncedAt,
      attentionUpdatedAt: row.attentionUpdatedAt,
      hasOutstandingRequest: row.hasOutstandingRequest,
      attentionUnread: row.attentionUnread,
      lastRequestedAt: row.lastRequestedAt,
    );
  }

  CachedSessionsCompanion _recentSessionCompanion(FleetRecentSession session) {
    return CachedSessionsCompanion.insert(
      workspaceId: session.workspaceId,
      peonId: session.peonId,
      sessionId: session.sessionId,
      status: Value(session.status),
      projectKey: Value(session.projectKey),
      projectId: Value(session.projectId),
      title: Value(session.title),
      promptPreview: Value(session.promptPreview),
      preview: Value(session.preview),
      startedAt: Value(session.startedAt),
      lastActivityAt: Value(session.lastActivityAt),
      syncedAt: session.syncedAt,
      attentionUnread: Value(session.attentionUnread),
      attentionUpdatedAt: Value(session.attentionUpdatedAt),
      operatorRequested: const Value(true),
      hasOutstandingRequest: Value(session.hasOutstandingRequest),
      lastRequestedAt: Value(session.lastRequestedAt),
    );
  }
}
