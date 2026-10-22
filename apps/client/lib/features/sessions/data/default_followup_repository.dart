import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:drift/drift.dart';

import '../../../core/database/app_database.dart';
import '../../../core/ids/request_id.dart';
import '../../../core/time/app_time.dart';
import '../../../shared/models/ai_capabilities.dart';
import '../domain/followup_repository.dart';
import '../domain/new_session_repository.dart';
import '../domain/session_models.dart';
import 'session_data_helpers.dart';

class DefaultFollowupRepository implements FollowupRepository {
  DefaultFollowupRepository({
    required this.database,
    required this._dio,
    this._clock = const SystemAppClock(),
  });

  final AppDatabase database;
  final Dio _dio;
  final AppClock _clock;

  @override
  Future<ComposerDraftState> loadDraft(FollowupScope scope) async {
    final row =
        await (database.select(database.composerDrafts)..where(
              (row) => row.matchesSession(
                scope.workspaceId,
                scope.peonId,
                scope.sessionId,
              ),
            ))
            .getSingleOrNull();
    if (row == null) return const ComposerDraftState();
    return ComposerDraftState(
      text: row.draftText,
      agent: row.agent,
      model: row.model,
      reasoningEffort: row.reasoningEffort,
    );
  }

  @override
  Future<void> saveDraft(FollowupScope scope, ComposerDraftState draft) async {
    if (draft.isEmpty) {
      await (database.delete(database.composerDrafts)..where(
            (row) => row.matchesSession(
              scope.workspaceId,
              scope.peonId,
              scope.sessionId,
            ),
          ))
          .go();
      return;
    }
    await database
        .into(database.composerDrafts)
        .insertOnConflictUpdate(
          ComposerDraftsCompanion.insert(
            workspaceId: scope.workspaceId,
            peonId: scope.peonId,
            sessionId: scope.sessionId,
            draftText: draft.text,
            agent: Value(draft.agent),
            model: Value(draft.model),
            reasoningEffort: Value(draft.reasoningEffort),
            updatedAt: _clock.now().millisecondsSinceEpoch.toDouble(),
          ),
        );
  }

  SimpleSelectStatement<$PendingFollowupCommandsTable, PendingFollowupCommand>
  _pendingQuery(FollowupScope scope) {
    return database.select(database.pendingFollowupCommands)
      ..where(
        (row) => row.matchesSession(
          scope.workspaceId,
          scope.peonId,
          scope.sessionId,
        ),
      )
      ..orderBy([(row) => OrderingTerm.asc(row.createdAt)]);
  }

  @override
  Stream<List<PendingFollowup>> watchPending(FollowupScope scope) {
    return _pendingQuery(
      scope,
    ).watch().map((rows) => rows.map(_pendingFromRow).toList(growable: false));
  }

  @override
  Stream<List<QueuedFollowup>> watchQueue(FollowupScope scope) {
    final query = database.select(database.cachedQueuedFollowups)
      ..where(
        (row) => row.matchesSession(
          scope.workspaceId,
          scope.peonId,
          scope.sessionId,
        ),
      )
      ..orderBy([(row) => OrderingTerm.asc(row.orderKey)]);
    return query.watch().map(
      (rows) => rows
          .map((row) {
            try {
              return _queuedFromJson(
                Map<String, dynamic>.from(jsonDecode(row.payloadJson) as Map),
              );
            } on FormatException {
              return null;
            } on TypeError {
              return null;
            }
          })
          .whereType<QueuedFollowup>()
          .toList(growable: false),
    );
  }

  @override
  Future<void> refreshQueue(FollowupScope scope) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '${_sessionBase(scope)}/queue',
      );
      final rawItems = response.data?['items'];
      final items = rawItems is List
          ? rawItems
                .whereType<Map>()
                .map((item) => Map<String, dynamic>.from(item))
                .map(_queuedFromJson)
                .toList(growable: false)
          : const <QueuedFollowup>[];
      await _replaceQueue(scope, items);
    } on DioException catch (error) {
      if (error.response?.statusCode == 404) {
        await _replaceQueue(scope, const []);
      }
      throw FollowupException(
        error.serverMessage ?? 'Queued messages could not be loaded.',
        statusCode: error.response?.statusCode,
      );
    } on FormatException {
      throw const FollowupException('The queued message list was invalid.');
    } on TypeError {
      throw const FollowupException('The queued message list was invalid.');
    }
  }

  Future<void> _replaceQueue(
    FollowupScope scope,
    List<QueuedFollowup> items,
  ) async {
    final syncedAt = _clock.now().millisecondsSinceEpoch.toDouble();
    await database.transaction(() async {
      await (database.delete(database.cachedQueuedFollowups)..where(
            (row) => row.matchesSession(
              scope.workspaceId,
              scope.peonId,
              scope.sessionId,
            ),
          ))
          .go();
      for (var index = 0; index < items.length; index++) {
        final item = items[index];
        await database
            .into(database.cachedQueuedFollowups)
            .insert(
              CachedQueuedFollowupsCompanion.insert(
                workspaceId: scope.workspaceId,
                peonId: scope.peonId,
                sessionId: scope.sessionId,
                itemId: item.id,
                payloadJson: jsonEncode(_queuedToJson(item)),
                orderKey: index,
                syncedAt: syncedAt,
              ),
            );
      }
    });
  }

  @override
  Future<void> editQueued(
    FollowupScope scope,
    String itemId,
    String prompt, {
    SelectedTextReply? replyTo,
  }) {
    return _mutateQueue(
      scope,
      itemId,
      method: 'PATCH',
      data: {
        'prompt': prompt,
        if (replyTo != null) 'replyTo': replyTo.toJson(),
      },
      fallback: 'Queued message could not be edited.',
    );
  }

  @override
  Future<void> removeQueued(FollowupScope scope, String itemId) {
    return _mutateQueue(
      scope,
      itemId,
      method: 'DELETE',
      fallback: 'Queued message could not be removed.',
    );
  }

  @override
  Future<void> steerQueued(FollowupScope scope, String itemId) {
    return _mutateQueue(
      scope,
      itemId,
      method: 'POST',
      suffix: '/steer',
      fallback: 'Queued message could not steer the active turn.',
    );
  }

  Future<void> _mutateQueue(
    FollowupScope scope,
    String itemId, {
    required String method,
    required String fallback,
    String suffix = '',
    Object? data,
  }) async {
    FollowupException? failure;
    try {
      await _dio.request<void>(
        '${_sessionBase(scope)}/queue/${Uri.encodeComponent(itemId)}$suffix',
        data: data,
        options: Options(method: method),
      );
    } on DioException catch (error) {
      if (!_isUnknownQueueItem(error)) {
        failure = FollowupException(error.serverMessage ?? fallback);
      }
    } finally {
      try {
        await refreshQueue(scope);
      } on FollowupException catch (error) {
        failure ??= error;
      }
    }
    if (failure != null) throw failure;
  }

  @override
  Future<ModelsCatalog?> fetchModelCatalog(FollowupScope scope) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        'workspaces/${Uri.encodeComponent(scope.workspaceId)}'
        '/peons/${Uri.encodeComponent(scope.peonId)}/models',
      );
      final data = response.data;
      if (data == null) return null;
      if (data['providers'] is! List) return null;
      return ModelsCatalog.fromJson(data);
    } on DioException catch (error) {
      // A missing endpoint is a stable capability absence. Transport and
      // server failures are recoverable and must reach the composer's retry.
      if (error.response?.statusCode == 404) return null;
      throw FollowupException(
        error.serverMessage ?? 'Model choices could not be loaded.',
        statusCode: error.response?.statusCode,
      );
    } on TypeError {
      return null;
    }
  }

  @override
  Future<FollowupDelivery> submit({
    required FollowupScope scope,
    required String prompt,
    required bool serverQueue,
    bool startNow = false,
    String? model,
    String? reasoningEffort,
    String? commandId,
    List<NewSessionAttachment> attachments = const [],
    SelectedTextReply? replyTo,
    SubmissionProgressCallback? onProgress,
  }) async {
    final trimmed = prompt.trim();
    if (trimmed.isEmpty && attachments.isEmpty) {
      throw const FollowupException('Message cannot be empty.');
    }
    final stableCommandId = commandId ?? newRequestId();
    final uploaded = await uploadAttachments(
      dio: _dio,
      workspaceId: scope.workspaceId,
      peonId: scope.peonId,
      uploadId: stableCommandId,
      attachments: attachments,
      reportLocalSize: true,
      error: (message, statusCode) =>
          FollowupException(message, statusCode: statusCode),
      onUploading: onProgress == null
          ? null
          : (current, total, fileName) => onProgress(
              SubmissionProgress.uploading(
                current: current,
                total: total,
                fileName: fileName,
              ),
            ),
    );
    onProgress?.call(const SubmissionProgress.submitting());
    final command = PendingFollowup(
      commandId: stableCommandId,
      scope: scope,
      prompt: trimmed.isEmpty ? '(see attachments)' : trimmed,
      serverQueue: serverQueue,
      startNow: startNow,
      createdAt: _clock.now().microsecondsSinceEpoch / 1000,
      model: model,
      reasoningEffort: reasoningEffort,
      attachments: uploaded,
      replyTo: replyTo,
    );
    final earlier = await _pendingQuery(scope).get();
    await database
        .into(database.pendingFollowupCommands)
        .insert(
          PendingFollowupCommandsCompanion.insert(
            commandId: command.commandId,
            workspaceId: scope.workspaceId,
            peonId: scope.peonId,
            sessionId: scope.sessionId,
            prompt: command.prompt,
            serverQueue: command.serverQueue,
            startNow: Value(command.startNow),
            model: Value(command.model),
            reasoningEffort: Value(command.reasoningEffort),
            attachmentsJson: Value(
              jsonEncode([
                for (final attachment in command.attachments)
                  {
                    'type': attachment.type,
                    'path': attachment.path,
                    'name': ?attachment.name,
                    'size': ?attachment.size,
                    'transferId': ?attachment.transferId,
                    'sha256': ?attachment.sha256,
                  },
              ]),
            ),
            replyToJson: Value(
              replyTo == null ? null : jsonEncode(replyTo.toJson()),
            ),
            createdAt: command.createdAt,
          ),
        );
    if (earlier.isNotEmpty) return FollowupDelivery.queued;
    return _dispatch(command);
  }

  @override
  Future<bool> retryPending(FollowupScope scope) async {
    final rows = await _pendingQuery(scope).get();
    for (final row in rows) {
      final result = await _dispatch(_pendingFromRow(row));
      if (result == FollowupDelivery.queued) return true;
    }
    return false;
  }

  Future<FollowupDelivery> _dispatch(PendingFollowup command) async {
    try {
      final scope = command.scope;
      final base = _sessionBase(scope);
      if (command.serverQueue) {
        await _dio.post<void>(
          '$base/queue',
          data: <String, dynamic>{
            'prompt': command.prompt,
            'commandId': command.commandId,
            'startNow': command.startNow,
            if (command.model != null) 'model': command.model,
            if (command.reasoningEffort != null)
              'reasoningEffort': command.reasoningEffort,
            if (command.attachments.isNotEmpty)
              'attachments': attachmentPayload(command.attachments),
            if (command.replyTo != null) 'replyTo': command.replyTo!.toJson(),
          },
        );
      } else {
        await _dio.post<void>(
          '$base/followup',
          data: <String, dynamic>{
            'prompt': command.prompt,
            if (command.model != null) 'model': command.model,
            if (command.reasoningEffort != null)
              'reasoningEffort': command.reasoningEffort,
            if (command.attachments.isNotEmpty)
              'attachments': attachmentPayload(command.attachments),
            if (command.replyTo != null) 'replyTo': command.replyTo!.toJson(),
          },
          options: Options(headers: {'Peon-Request-Id': command.commandId}),
        );
      }
      await (database.update(database.cachedSessions)..where(
            (row) => row.matchesSession(
              scope.workspaceId,
              scope.peonId,
              scope.sessionId,
            ),
          ))
          .write(
            CachedSessionsCompanion(
              operatorRequested: const Value(true),
              hasOutstandingRequest: const Value(true),
              lastRequestedAt: Value(command.createdAt),
            ),
          );
      await _complete(command.commandId);
      return FollowupDelivery.delivered;
    } on DioException catch (error) {
      if (_isRetryable(error)) return FollowupDelivery.queued;
      await _complete(command.commandId);
      throw FollowupException(
        error.serverMessage ?? 'Message could not be sent.',
        statusCode: error.response?.statusCode,
      );
    }
  }

  Future<void> _complete(String commandId) {
    return (database.delete(
      database.pendingFollowupCommands,
    )..where((row) => row.commandId.equals(commandId))).go();
  }

  bool _isRetryable(DioException error) {
    final status = error.response?.statusCode;
    if (status != null) {
      return status == 408 || status == 425 || status == 429 || status >= 500;
    }
    return switch (error.type) {
      DioExceptionType.badCertificate ||
      DioExceptionType.badResponse ||
      DioExceptionType.cancel => false,
      _ => true,
    };
  }

  String _sessionBase(FollowupScope scope) =>
      'workspaces/${Uri.encodeComponent(scope.workspaceId)}'
      '/peons/${Uri.encodeComponent(scope.peonId)}'
      '/sessions/${Uri.encodeComponent(scope.sessionId)}';

  bool _isUnknownQueueItem(DioException error) {
    final data = error.response?.data;
    return data is Map && data['code'] == 'UNKNOWN_QUEUE_ITEM';
  }

  QueuedFollowup _queuedFromJson(Map<String, dynamic> json) {
    final id = json['id'];
    if (id is! String || id.isEmpty) {
      throw const FormatException('Missing queue item id');
    }
    final rawAttachments = json['attachments'];
    SelectedTextReply? replyTo;
    if (json['replyTo'] != null) {
      try {
        replyTo = SelectedTextReply.fromJson(json['replyTo']);
      } on FormatException {
        throw const FormatException('Invalid queued selected-text reply');
      }
    }
    return QueuedFollowup(
      id: id,
      sessionId: json['sessionId'] as String? ?? '',
      prompt: json['prompt'] as String? ?? '',
      attachments: rawAttachments is List
          ? rawAttachments
                .whereType<Map>()
                .map((raw) => Map<String, dynamic>.from(raw))
                .map(
                  (raw) => QueuedFollowupAttachment(
                    type: raw['type'] as String? ?? 'file',
                    path: raw['path'] as String?,
                    name: raw['name'] as String?,
                    size: (raw['size'] as num?)?.toInt(),
                  ),
                )
                .toList(growable: false)
          : const [],
      author: json['author'] as String?,
      model: json['model'] as String?,
      reasoningEffort: json['reasoningEffort'] as String?,
      commandId: json['commandId'] as String?,
      queuedAt: (json['queuedAt'] as num?)?.toDouble() ?? 0,
      replyTo: replyTo,
    );
  }

  Map<String, dynamic> _queuedToJson(QueuedFollowup item) => {
    'id': item.id,
    'sessionId': item.sessionId,
    'prompt': item.prompt,
    'attachments': [
      for (final attachment in item.attachments)
        {
          'type': attachment.type,
          if (attachment.path != null) 'path': attachment.path,
          if (attachment.name != null) 'name': attachment.name,
          if (attachment.size != null) 'size': attachment.size,
        },
    ],
    'author': item.author,
    'model': item.model,
    'reasoningEffort': item.reasoningEffort,
    'commandId': item.commandId,
    'queuedAt': item.queuedAt,
    if (item.replyTo != null) 'replyTo': item.replyTo!.toJson(),
  };

  PendingFollowup _pendingFromRow(PendingFollowupCommand row) {
    return PendingFollowup(
      commandId: row.commandId,
      scope: FollowupScope(
        workspaceId: row.workspaceId,
        peonId: row.peonId,
        sessionId: row.sessionId,
      ),
      prompt: row.prompt,
      serverQueue: row.serverQueue,
      startNow: row.startNow,
      createdAt: row.createdAt,
      model: row.model,
      reasoningEffort: row.reasoningEffort,
      attachments: _pendingAttachments(row.attachmentsJson),
      replyTo: row.replyToJson == null
          ? null
          : SelectedTextReply.fromJson(jsonDecode(row.replyToJson!)),
    );
  }

  List<FollowupAttachment> _pendingAttachments(String raw) {
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) return const [];
      return decoded
          .whereType<Map>()
          .map((item) => Map<String, dynamic>.from(item))
          .where((item) => item['path'] is String)
          .map(
            (item) => FollowupAttachment(
              type: item['type'] as String? ?? 'file',
              path: item['path'] as String,
              name: item['name'] as String?,
              size: (item['size'] as num?)?.toInt(),
              transferId: item['transferId'] as String?,
              sha256: item['sha256'] as String?,
            ),
          )
          .toList(growable: false);
    } on FormatException {
      return const [];
    } on TypeError {
      return const [];
    }
  }
}
