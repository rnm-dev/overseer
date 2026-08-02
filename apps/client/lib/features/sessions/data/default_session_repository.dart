import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:drift/drift.dart';

import '../../../core/database/app_database.dart';
import '../../../core/live/live_projection_sink.dart';
import '../../../core/network/overseer_http_client.dart';
import '../../../core/time/app_time.dart';
import '../domain/session_models.dart';
import '../domain/session_repository.dart';
import 'project_session_count_cache.dart';

class DefaultSessionRepository
    implements SessionRepository, AttentionProjectionSink {
  DefaultSessionRepository({
    required this.database,
    required Uri apiUrl,
    required String token,
    Dio? dio,
    this._clock = const SystemAppClock(),
  }) : _dio = dio ?? createOverseerHttpClient(apiUrl: apiUrl, token: token);

  final AppDatabase database;
  final Dio _dio;
  final AppClock _clock;

  SimpleSelectStatement<$CachedSessionsTable, CachedSession> _sessionQuery({
    required String workspaceId,
    required String peonId,
  }) {
    return database.select(database.cachedSessions)
      ..where(
        (row) =>
            row.workspaceId.equals(workspaceId) & row.peonId.equals(peonId),
      )
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
      ]);
  }

  @override
  Future<List<SessionSummary>> loadCachedSessions({
    required String workspaceId,
    required String peonId,
  }) async {
    final rows = await _sessionQuery(
      workspaceId: workspaceId,
      peonId: peonId,
    ).get();
    return rows.map(_domainFromRow).toList(growable: false);
  }

  @override
  Stream<List<SessionSummary>> watchSessions({
    required String workspaceId,
    required String peonId,
  }) {
    return _sessionQuery(
      workspaceId: workspaceId,
      peonId: peonId,
    ).watch().map((rows) => rows.map(_domainFromRow).toList(growable: false));
  }

  @override
  Future<SessionPage> fetchPage({
    required String workspaceId,
    required String peonId,
    required int offset,
    int limit = 50,
  }) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        'workspaces/${Uri.encodeComponent(workspaceId)}/sessions',
        queryParameters: {'peonId': peonId, 'limit': limit, 'offset': offset},
      );
      final payload = response.data;
      final rawSessions = payload?['sessions'];
      if (rawSessions is! List) {
        throw const FormatException('Invalid sessions response');
      }
      final decodedSessions = rawSessions
          .map((item) {
            final json = Map<String, dynamic>.from(item as Map);
            return (json: json, session: _domainFromJson(workspaceId, json));
          })
          .toList(growable: false);
      final sessions = decodedSessions
          .map((item) => item.session)
          .toList(growable: false);
      await database.batch((batch) {
        for (final item in decodedSessions) {
          final session = item.session;
          final includeAttentionState =
              item.json.containsKey('attentionUnread') ||
              item.json.containsKey('attentionUpdatedAt');
          final includeOperatorState =
              item.json.containsKey('operatorRequested') ||
              item.json.containsKey('hasOutstandingRequest') ||
              item.json.containsKey('lastRequestedAt');
          batch.insert(
            database.cachedSessions,
            _companion(
              session,
              includeAttentionState: includeAttentionState,
              includeOperatorState: includeOperatorState,
            ),
            onConflict: DoUpdate<CachedSessions, CachedSession>(
              (_) => _companion(
                session,
                includeAttentionState: includeAttentionState,
                includeOperatorState: includeOperatorState,
              ),
              where: (old) =>
                  old.syncedAt.isSmallerOrEqualValue(session.syncedAt),
            ),
          );
        }
      });

      final catalogs = payload?['catalogs'];
      final catalogStale =
          catalogs is List &&
          catalogs.whereType<Map>().any(
            (catalog) =>
                catalog['peonId'] == peonId && catalog['stale'] == true,
          );
      return SessionPage(
        sessions: sessions,
        total: (payload?['total'] as num?)?.toInt() ?? sessions.length,
        offset: (payload?['offset'] as num?)?.toInt() ?? offset,
        limit: (payload?['limit'] as num?)?.toInt() ?? limit,
        catalogStale: catalogStale,
      );
    } on DioException catch (error) {
      final data = error.response?.data;
      final message = data is Map<String, dynamic>
          ? data['error'] as String?
          : null;
      throw SessionsException(
        message ??
            'Could not refresh sessions. Cached sessions are still available.',
      );
    } on FormatException {
      throw const SessionsException(
        'Overseer returned an invalid sessions response.',
      );
    } on TypeError {
      throw const SessionsException(
        'Overseer returned an invalid sessions response.',
      );
    }
  }

  @override
  Future<SessionDetails> fetchDetails({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        'workspaces/${Uri.encodeComponent(workspaceId)}'
        '/peons/${Uri.encodeComponent(peonId)}'
        '/sessions/${Uri.encodeComponent(sessionId)}',
      );
      final payload = response.data;
      if (payload == null) {
        throw const FormatException('Invalid session response');
      }
      final usage = payload['usage'];
      return SessionDetails(
        turnCount: (payload['turnCount'] as num?)?.toInt() ?? 0,
        status: payload['status'] as String?,
        projectKey: payload['projectKey'] as String?,
        projectId: payload['projectId'] as String?,
        projectRoot: payload['projectRoot'] as String?,
        agent: payload['agent'] as String?,
        model: payload['model'] as String?,
        reasoningEffort: payload['reasoningEffort'] as String?,
        usage: usage is Map
            ? _usageFromJson(Map<String, dynamic>.from(usage))
            : null,
      );
    } on DioException catch (error) {
      throw SessionsException(
        error.response?.statusCode == 404
            ? 'This session is no longer available.'
            : 'Could not load session details.',
      );
    } on FormatException {
      throw const SessionsException('The session response was invalid.');
    } on TypeError {
      throw const SessionsException('The session response was invalid.');
    }
  }

  @override
  Future<void> markSessionAttentionRead({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) async {
    try {
      await _dio.post<void>(
        'workspaces/${Uri.encodeComponent(workspaceId)}'
        '/peons/${Uri.encodeComponent(peonId)}'
        '/sessions/${Uri.encodeComponent(sessionId)}/attention/read',
      );
      await (database.update(database.cachedSessions)..where(
            (row) =>
                row.workspaceId.equals(workspaceId) &
                row.peonId.equals(peonId) &
                row.sessionId.equals(sessionId),
          ))
          .write(
            CachedSessionsCompanion(
              attentionUnread: const Value(false),
              attentionUpdatedAt: Value(
                _clock.now().millisecondsSinceEpoch.toDouble(),
              ),
            ),
          );
    } on DioException {
      throw const SessionsException('Could not mark this session as read.');
    }
  }

  @override
  Future<void> cancelSession({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) async {
    try {
      await _dio.post<void>(
        'workspaces/${Uri.encodeComponent(workspaceId)}'
        '/peons/${Uri.encodeComponent(peonId)}'
        '/sessions/${Uri.encodeComponent(sessionId)}/cancel',
      );
    } on DioException catch (error) {
      final data = error.response?.data;
      final serverMessage = data is Map ? data['error'] as String? : null;
      throw SessionsException(
        serverMessage ??
            switch (error.response?.statusCode) {
              409 => 'This session is no longer running.',
              404 => 'Stopping is unavailable. Update the Peon.',
              _ => 'Could not stop this session.',
            },
      );
    }
  }

  @override
  Future<void> renameSession({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String? title,
  }) async {
    try {
      await _dio.patch<void>(
        'workspaces/${Uri.encodeComponent(workspaceId)}'
        '/peons/${Uri.encodeComponent(peonId)}'
        '/sessions/${Uri.encodeComponent(sessionId)}',
        data: {'title': title},
      );
      await (database.update(database.cachedSessions)..where(
            (row) =>
                row.workspaceId.equals(workspaceId) &
                row.peonId.equals(peonId) &
                row.sessionId.equals(sessionId),
          ))
          .write(CachedSessionsCompanion(title: Value(title)));
    } on DioException catch (error) {
      final data = error.response?.data;
      final serverMessage = data is Map ? data['error'] as String? : null;
      throw SessionsException(
        serverMessage ??
            switch (error.response?.statusCode) {
              404 => 'Renaming is unavailable. Update the Peon.',
              _ => 'Could not rename this session.',
            },
      );
    }
  }

  @override
  Future<void> deleteSession({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) async {
    try {
      await _dio.delete<void>(
        'workspaces/${Uri.encodeComponent(workspaceId)}'
        '/peons/${Uri.encodeComponent(peonId)}'
        '/sessions/${Uri.encodeComponent(sessionId)}',
      );
      await database.transaction(() async {
        final existing =
            await (database.select(database.cachedSessions)..where(
                  (row) =>
                      row.workspaceId.equals(workspaceId) &
                      row.peonId.equals(peonId) &
                      row.sessionId.equals(sessionId),
                ))
                .getSingleOrNull();
        await (database.delete(database.cachedSessions)..where(
              (row) =>
                  row.workspaceId.equals(workspaceId) &
                  row.peonId.equals(peonId) &
                  row.sessionId.equals(sessionId),
            ))
            .go();
        if (existing != null) {
          await adjustCachedProjectSessionCount(
            database: database,
            workspaceId: workspaceId,
            peonId: peonId,
            projectId: existing.projectId,
            projectKey: existing.projectKey,
            delta: -1,
          );
        }
      });
    } on DioException catch (error) {
      final data = error.response?.data;
      final serverMessage = data is Map ? data['error'] as String? : null;
      throw SessionsException(
        serverMessage ??
            switch (error.response?.statusCode) {
              404 => 'This session is no longer available.',
              _ => 'Could not delete this session.',
            },
      );
    }
  }

  SimpleSelectStatement<$CachedTranscriptEventsTable, CachedTranscriptEvent>
  _transcriptQuery({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) {
    return database.select(database.cachedTranscriptEvents)
      ..where(
        (row) =>
            row.workspaceId.equals(workspaceId) &
            row.peonId.equals(peonId) &
            row.sessionId.equals(sessionId),
      )
      ..orderBy([(row) => OrderingTerm.asc(row.orderKey)]);
  }

  @override
  Future<TranscriptCache> loadCachedTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) async {
    final rows = await _transcriptQuery(
      workspaceId: workspaceId,
      peonId: peonId,
      sessionId: sessionId,
    ).get();
    final metadata =
        await (database.select(database.cachedTranscripts)..where(
              (row) =>
                  row.workspaceId.equals(workspaceId) &
                  row.peonId.equals(peonId) &
                  row.sessionId.equals(sessionId),
            ))
            .getSingleOrNull();
    return TranscriptCache(
      events: rows.map(_transcriptFromRow).toList(growable: false),
      hasOlder: metadata?.hasOlder ?? false,
    );
  }

  @override
  Stream<List<TranscriptEvent>> watchTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) {
    return _transcriptQuery(
      workspaceId: workspaceId,
      peonId: peonId,
      sessionId: sessionId,
    ).watch().map(
      (rows) => rows.map(_transcriptFromRow).toList(growable: false),
    );
  }

  @override
  Future<TranscriptPage> fetchLatestTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    int limit = 50,
  }) {
    return _fetchTranscript(
      workspaceId: workspaceId,
      peonId: peonId,
      sessionId: sessionId,
      limit: limit,
      cursor: null,
      prepend: false,
    );
  }

  @override
  Future<TranscriptPage> fetchOlderTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String cursor,
    int limit = 50,
  }) {
    return _fetchTranscript(
      workspaceId: workspaceId,
      peonId: peonId,
      sessionId: sessionId,
      limit: limit,
      cursor: cursor,
      prepend: true,
    );
  }

  Future<TranscriptPage> _fetchTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required int limit,
    required String? cursor,
    required bool prepend,
  }) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        'workspaces/${Uri.encodeComponent(workspaceId)}'
        '/peons/${Uri.encodeComponent(peonId)}'
        '/sessions/${Uri.encodeComponent(sessionId)}/transcript',
        queryParameters: {'limit': limit, 'cursor': ?cursor},
      );
      final payload = response.data;
      final rawEvents = payload?['events'];
      final rawHasMore = payload?['hasMore'];
      if (payload == null ||
          rawEvents is! List ||
          rawHasMore is! bool ||
          (rawHasMore && payload['nextCursor'] is! String)) {
        throw const FormatException('Invalid transcript response');
      }
      final nextCursor = payload['nextCursor'] as String?;
      final incoming = <Map<String, dynamic>>[];
      final incomingIds = <String>{};
      for (final item in rawEvents) {
        if (item is! Map) {
          throw const FormatException('Invalid transcript event');
        }
        final event = Map<String, dynamic>.from(item);
        final eventId = event['eventId'];
        if (eventId is! String ||
            eventId.isEmpty ||
            !incomingIds.add(eventId)) {
          throw const FormatException('Invalid transcript event identity');
        }
        incoming.add(event);
      }

      late List<String> orderedIds;
      late int insertedCount;
      final updatedAt = _clock.now().millisecondsSinceEpoch.toDouble();
      await database.transaction(() async {
        final existingRows = await _transcriptQuery(
          workspaceId: workspaceId,
          peonId: peonId,
          sessionId: sessionId,
        ).get();
        final existingIds = existingRows
            .map((row) => row.eventId)
            .toList(growable: true);
        final existingSet = existingIds.toSet();
        insertedCount = incomingIds.difference(existingSet).length;
        orderedIds = _mergeTranscriptOrder(
          existingIds: existingIds,
          incomingIds: incoming
              .map((event) => event['eventId']! as String)
              .toList(growable: false),
          prependWhenDisjoint: prepend,
        );

        for (var index = 0; index < orderedIds.length; index++) {
          final eventId = orderedIds[index];
          await (database.update(database.cachedTranscriptEvents)..where(
                (row) =>
                    row.workspaceId.equals(workspaceId) &
                    row.peonId.equals(peonId) &
                    row.sessionId.equals(sessionId) &
                    row.eventId.equals(eventId),
              ))
              .write(CachedTranscriptEventsCompanion(orderKey: Value(index)));
        }

        final orderById = {
          for (var index = 0; index < orderedIds.length; index++)
            orderedIds[index]: index,
        };
        for (final event in incoming) {
          final eventId = event['eventId']! as String;
          await database
              .into(database.cachedTranscriptEvents)
              .insertOnConflictUpdate(
                CachedTranscriptEventsCompanion.insert(
                  workspaceId: workspaceId,
                  peonId: peonId,
                  sessionId: sessionId,
                  eventId: eventId,
                  orderKey: orderById[eventId]!,
                  eventType: Value(event['type'] as String?),
                  payloadJson: jsonEncode(event),
                  createdAt: Value((event['createdAt'] as num?)?.toDouble()),
                  updatedAt: updatedAt,
                ),
              );
        }
        await database
            .into(database.cachedTranscripts)
            .insertOnConflictUpdate(
              CachedTranscriptsCompanion.insert(
                workspaceId: workspaceId,
                peonId: peonId,
                sessionId: sessionId,
                hasOlder: Value(rawHasMore),
                syncedAt: Value(updatedAt),
              ),
            );
      });

      final orderById = {
        for (var index = 0; index < orderedIds.length; index++)
          orderedIds[index]: index,
      };
      return TranscriptPage(
        events: [
          for (final event in incoming)
            TranscriptEvent(
              eventId: event['eventId']! as String,
              orderKey: orderById[event['eventId']]!,
              payload: event,
            ),
        ],
        nextCursor: nextCursor,
        hasMore: rawHasMore,
        insertedCount: insertedCount,
      );
    } on DioException catch (error) {
      final data = error.response?.data;
      final message = data is Map ? data['error'] as String? : null;
      throw SessionsException(message ?? 'Could not load the transcript.');
    } on FormatException {
      throw const SessionsException(
        'Overseer returned an invalid transcript response.',
      );
    } on TypeError {
      throw const SessionsException(
        'Overseer returned an invalid transcript response.',
      );
    }
  }

  @override
  Future<void> cacheTailEvent({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String eventId,
    required Map<String, dynamic> payload,
  }) async {
    if (eventId.isEmpty) {
      throw const SessionsException(
        'A live transcript event had no durable identity.',
      );
    }
    final event = Map<String, dynamic>.from(payload)..['eventId'] = eventId;
    final updatedAt = _clock.now().millisecondsSinceEpoch.toDouble();
    await database.transaction(() async {
      final existing =
          await (database.select(database.cachedTranscriptEvents)..where(
                (row) =>
                    row.workspaceId.equals(workspaceId) &
                    row.peonId.equals(peonId) &
                    row.sessionId.equals(sessionId) &
                    row.eventId.equals(eventId),
              ))
              .getSingleOrNull();
      final rows = await _transcriptQuery(
        workspaceId: workspaceId,
        peonId: peonId,
        sessionId: sessionId,
      ).get();
      final orderKey =
          existing?.orderKey ?? (rows.lastOrNull?.orderKey ?? -1) + 1;
      await database
          .into(database.cachedTranscriptEvents)
          .insertOnConflictUpdate(
            CachedTranscriptEventsCompanion.insert(
              workspaceId: workspaceId,
              peonId: peonId,
              sessionId: sessionId,
              eventId: eventId,
              orderKey: orderKey,
              eventType: Value(event['type'] as String?),
              payloadJson: jsonEncode(event),
              createdAt: Value((event['createdAt'] as num?)?.toDouble()),
              updatedAt: updatedAt,
            ),
          );
      final metadata =
          await (database.select(database.cachedTranscripts)..where(
                (row) =>
                    row.workspaceId.equals(workspaceId) &
                    row.peonId.equals(peonId) &
                    row.sessionId.equals(sessionId),
              ))
              .getSingleOrNull();
      await database
          .into(database.cachedTranscripts)
          .insertOnConflictUpdate(
            CachedTranscriptsCompanion.insert(
              workspaceId: workspaceId,
              peonId: peonId,
              sessionId: sessionId,
              hasOlder: Value(metadata?.hasOlder ?? false),
              syncedAt: Value(updatedAt),
            ),
          );
    });
  }

  @override
  Future<void> applyLiveProjection({
    required String workspaceId,
    required int cursor,
    required Map<String, dynamic> projection,
  }) async {
    final peonId = projection['peonId'];
    final sessionId = projection['sessionId'];
    if (peonId is! String || sessionId is! String) {
      await advanceCursor(workspaceId: workspaceId, cursor: cursor);
      return;
    }
    final syncedAt = (projection['syncedAt'] as num?)?.toDouble() ?? 0;
    await database.transaction(() async {
      if (projection['deleted'] == true) {
        await (database.delete(database.cachedSessions)..where(
              (row) =>
                  row.workspaceId.equals(workspaceId) &
                  row.peonId.equals(peonId) &
                  row.sessionId.equals(sessionId) &
                  row.syncedAt.isSmallerOrEqualValue(syncedAt),
            ))
            .go();
      } else {
        final session = _domainFromJson(workspaceId, projection);
        final companion = _companion(
          session,
          includeAttentionState:
              projection.containsKey('attentionUnread') ||
              projection.containsKey('attentionUpdatedAt'),
          includeOperatorState:
              projection.containsKey('hasOutstandingRequest') ||
              projection.containsKey('lastRequestedAt'),
        );
        await database
            .into(database.cachedSessions)
            .insert(
              companion,
              onConflict: DoUpdate(
                (_) => companion,
                where: (old) =>
                    old.syncedAt.isSmallerOrEqualValue(session.syncedAt),
              ),
            );
      }
      await applyAuthoritativeProjectSessionCounts(
        database: database,
        workspaceId: workspaceId,
        peonId: peonId,
        rawCounts: projection['projectSessionCounts'],
      );
      await _advanceCursorInTransaction(workspaceId, cursor);
    });
  }

  @override
  Future<void> applyAttentionProjection({
    required String workspaceId,
    required int cursor,
    required Map<String, dynamic> projection,
  }) async {
    final peonId = projection['peonId'];
    final sessionId = projection['sessionId'];
    if (peonId is! String || sessionId is! String) {
      await advanceCursor(workspaceId: workspaceId, cursor: cursor);
      return;
    }
    final updatedAt = (projection['updatedAt'] as num?)?.toDouble() ?? 0;
    final companion = CachedSessionsCompanion.insert(
      workspaceId: workspaceId,
      peonId: peonId,
      sessionId: sessionId,
      syncedAt: 0,
      operatorRequested: const Value(true),
      hasOutstandingRequest: projection.containsKey('hasOutstandingRequest')
          ? Value(projection['hasOutstandingRequest'] as bool? ?? false)
          : const Value.absent(),
      lastRequestedAt: projection.containsKey('lastRequestedAt')
          ? Value((projection['lastRequestedAt'] as num?)?.toDouble())
          : const Value.absent(),
      attentionUnread: projection.containsKey('unread')
          ? Value(projection['unread'] as bool? ?? false)
          : projection.containsKey('attentionUnread')
          ? Value(projection['attentionUnread'] as bool? ?? false)
          : const Value.absent(),
      attentionUpdatedAt: Value(updatedAt),
    );
    await database.transaction(() async {
      await database
          .into(database.cachedSessions)
          .insert(
            companion,
            onConflict: DoUpdate(
              (_) => companion,
              where: (old) =>
                  old.attentionUpdatedAt.isSmallerOrEqualValue(updatedAt),
            ),
          );
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

  SessionSummary _domainFromJson(
    String workspaceId,
    Map<String, dynamic> json,
  ) {
    return SessionSummary(
      workspaceId: workspaceId,
      peonId: json['peonId'] as String,
      sessionId: json['sessionId'] as String,
      status: json['status'] as String?,
      projectKey: json['projectKey'] as String?,
      projectId: json['projectId'] as String?,
      title: json['title'] as String?,
      promptPreview: json['promptPreview'] as String?,
      preview: json['preview'] as String?,
      author: json['author'] as String?,
      outcomeJson: json['outcome'] == null ? null : jsonEncode(json['outcome']),
      startedAt: (json['startedAt'] as num?)?.toDouble(),
      endedAt: (json['endedAt'] as num?)?.toDouble(),
      lastActivityAt: (json['lastActivityAt'] as num?)?.toDouble(),
      syncedAt: (json['syncedAt'] as num?)?.toDouble() ?? 0,
      attentionUnread: json['attentionUnread'] as bool? ?? false,
      attentionUpdatedAt: (json['attentionUpdatedAt'] as num?)?.toDouble() ?? 0,
      operatorRequested:
          (json['operatorRequested'] as bool?) ??
          (json.containsKey('hasOutstandingRequest') ||
              json.containsKey('lastRequestedAt')),
      hasOutstandingRequest: json['hasOutstandingRequest'] as bool? ?? false,
      lastRequestedAt: (json['lastRequestedAt'] as num?)?.toDouble(),
    );
  }

  SessionUsage _usageFromJson(Map<String, dynamic> json) {
    int value(String camelCase, String snakeCase) {
      return (json[camelCase] as num? ?? json[snakeCase] as num?)?.toInt() ?? 0;
    }

    return SessionUsage(
      inputTokens: value('inputTokens', 'input_tokens'),
      outputTokens: value('outputTokens', 'output_tokens'),
      cacheCreationInputTokens: value(
        'cacheCreationInputTokens',
        'cache_creation_input_tokens',
      ),
      cacheReadInputTokens: value(
        'cacheReadInputTokens',
        'cache_read_input_tokens',
      ),
    );
  }

  SessionSummary _domainFromRow(CachedSession row) {
    return SessionSummary(
      workspaceId: row.workspaceId,
      peonId: row.peonId,
      sessionId: row.sessionId,
      status: row.status,
      projectKey: row.projectKey,
      projectId: row.projectId,
      title: row.title,
      promptPreview: row.promptPreview,
      preview: row.preview,
      author: row.author,
      outcomeJson: row.outcomeJson,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      lastActivityAt: row.lastActivityAt,
      syncedAt: row.syncedAt,
      attentionUnread: row.attentionUnread,
      attentionUpdatedAt: row.attentionUpdatedAt,
      operatorRequested: row.operatorRequested,
      hasOutstandingRequest: row.hasOutstandingRequest,
      lastRequestedAt: row.lastRequestedAt,
    );
  }

  TranscriptEvent _transcriptFromRow(CachedTranscriptEvent row) {
    final payload = jsonDecode(row.payloadJson);
    if (payload is! Map) {
      throw const FormatException('Invalid cached transcript event');
    }
    return TranscriptEvent(
      eventId: row.eventId,
      orderKey: row.orderKey,
      payload: Map<String, dynamic>.from(payload),
    );
  }

  CachedSessionsCompanion _companion(
    SessionSummary session, {
    bool includeAttentionState = true,
    bool includeOperatorState = true,
  }) {
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
      author: Value(session.author),
      outcomeJson: Value(session.outcomeJson),
      startedAt: Value(session.startedAt),
      endedAt: Value(session.endedAt),
      lastActivityAt: Value(session.lastActivityAt),
      syncedAt: session.syncedAt,
      attentionUnread: includeAttentionState
          ? Value(session.attentionUnread)
          : const Value.absent(),
      attentionUpdatedAt: includeAttentionState
          ? Value(session.attentionUpdatedAt)
          : const Value.absent(),
      operatorRequested: includeOperatorState
          ? Value(session.operatorRequested)
          : const Value.absent(),
      hasOutstandingRequest: includeOperatorState
          ? Value(session.hasOutstandingRequest)
          : const Value.absent(),
      lastRequestedAt: includeOperatorState
          ? Value(session.lastRequestedAt)
          : const Value.absent(),
    );
  }
}

List<String> _mergeTranscriptOrder({
  required List<String> existingIds,
  required List<String> incomingIds,
  required bool prependWhenDisjoint,
}) {
  if (existingIds.isEmpty) return List.of(incomingIds);
  if (incomingIds.isEmpty) return List.of(existingIds);

  final incomingIndex = <String, int>{
    for (var index = 0; index < incomingIds.length; index++)
      incomingIds[index]: index,
  };
  final firstOverlap = existingIds.indexWhere(incomingIndex.containsKey);
  if (firstOverlap < 0) {
    return prependWhenDisjoint
        ? [...incomingIds, ...existingIds]
        : [...existingIds, ...incomingIds];
  }
  final lastOverlap = existingIds.lastIndexWhere(incomingIndex.containsKey);

  var previousIncomingIndex = -1;
  var overlapsInServerOrder = true;
  for (var index = firstOverlap; index <= lastOverlap; index++) {
    final serverIndex = incomingIndex[existingIds[index]];
    if (serverIndex == null) continue;
    if (serverIndex < previousIncomingIndex) {
      overlapsInServerOrder = false;
      break;
    }
    previousIncomingIndex = serverIndex;
  }

  final prefix = existingIds.take(firstOverlap);
  final suffix = existingIds.skip(lastOverlap + 1);
  if (!overlapsInServerOrder) {
    final middleExtras = existingIds
        .sublist(firstOverlap, lastOverlap + 1)
        .where((id) => !incomingIndex.containsKey(id));
    return [...prefix, ...incomingIds, ...middleExtras, ...suffix];
  }

  final extrasBeforeAnchor = <String, List<String>>{};
  final pendingExtras = <String>[];
  for (var index = firstOverlap + 1; index <= lastOverlap; index++) {
    final id = existingIds[index];
    if (incomingIndex.containsKey(id)) {
      if (pendingExtras.isNotEmpty) {
        extrasBeforeAnchor[id] = List.of(pendingExtras);
        pendingExtras.clear();
      }
    } else {
      pendingExtras.add(id);
    }
  }

  return [
    ...prefix,
    for (final id in incomingIds) ...[...?extrasBeforeAnchor[id], id],
    ...pendingExtras,
    ...suffix,
  ];
}
