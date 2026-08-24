import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:drift/drift.dart';

import '../../../core/database/app_database.dart';
import '../../../core/time/app_time.dart';
import '../../../shared/models/ai_capabilities.dart';
import '../domain/followup_repository.dart';
import '../domain/new_session_repository.dart';

class DefaultFollowupRepository implements FollowupRepository {
  DefaultFollowupRepository({
    required this.database,
    required this._dio,
    Random? random,
    this._clock = const SystemAppClock(),
  }) : _random = random ?? Random.secure();

  final AppDatabase database;
  final Dio _dio;
  final Random _random;
  final AppClock _clock;

  @override
  Future<String> loadDraft(FollowupScope scope) async {
    final row =
        await (database.select(database.composerDrafts)..where(
              (row) =>
                  row.workspaceId.equals(scope.workspaceId) &
                  row.peonId.equals(scope.peonId) &
                  row.sessionId.equals(scope.sessionId),
            ))
            .getSingleOrNull();
    return row?.draftText ?? '';
  }

  @override
  Future<void> saveDraft(FollowupScope scope, String text) async {
    if (text.isEmpty) {
      await (database.delete(database.composerDrafts)..where(
            (row) =>
                row.workspaceId.equals(scope.workspaceId) &
                row.peonId.equals(scope.peonId) &
                row.sessionId.equals(scope.sessionId),
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
            draftText: text,
            updatedAt: _clock.now().millisecondsSinceEpoch.toDouble(),
          ),
        );
  }

  SimpleSelectStatement<$PendingFollowupCommandsTable, PendingFollowupCommand>
  _pendingQuery(FollowupScope scope) {
    return database.select(database.pendingFollowupCommands)
      ..where(
        (row) =>
            row.workspaceId.equals(scope.workspaceId) &
            row.peonId.equals(scope.peonId) &
            row.sessionId.equals(scope.sessionId),
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
        (row) =>
            row.workspaceId.equals(scope.workspaceId) &
            row.peonId.equals(scope.peonId) &
            row.sessionId.equals(scope.sessionId),
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
      final data = error.response?.data;
      throw FollowupException(
        _queueError(error, 'Queued messages could not be loaded.'),
        statusCode: error.response?.statusCode,
        code: data is Map ? data['code'] as String? : null,
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
            (row) =>
                row.workspaceId.equals(scope.workspaceId) &
                row.peonId.equals(scope.peonId) &
                row.sessionId.equals(scope.sessionId),
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
  Future<void> editQueued(FollowupScope scope, String itemId, String prompt) {
    return _mutateQueue(
      scope,
      itemId,
      method: 'PATCH',
      data: {'prompt': prompt},
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
        failure = FollowupException(_queueError(error, fallback));
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
    } on DioException {
      return null;
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
    String? agent,
    String? model,
    String? reasoningEffort,
    String? commandId,
    List<NewSessionAttachment> attachments = const [],
    FollowupProgressCallback? onProgress,
  }) async {
    final trimmed = prompt.trim();
    if (trimmed.isEmpty && attachments.isEmpty) {
      throw const FollowupException('Message cannot be empty.');
    }
    final stableCommandId = commandId ?? _commandId();
    final uploaded = await _uploadAttachments(
      scope: scope,
      commandId: stableCommandId,
      attachments: attachments,
      onProgress: onProgress,
    );
    onProgress?.call(const FollowupSubmissionProgress.submitting());
    final command = PendingFollowup(
      commandId: stableCommandId,
      scope: scope,
      prompt: trimmed.isEmpty ? '(see attachments)' : trimmed,
      serverQueue: serverQueue,
      startNow: startNow,
      createdAt: _clock.now().microsecondsSinceEpoch / 1000,
      agent: agent,
      model: model,
      reasoningEffort: reasoningEffort,
      attachments: uploaded,
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
            agent: Value(command.agent),
            model: Value(command.model),
            reasoningEffort: Value(command.reasoningEffort),
            attachmentsJson: Value(
              jsonEncode([
                for (final attachment in command.attachments)
                  {
                    'type': attachment.type,
                    'path': attachment.path,
                    if (attachment.name != null) 'name': attachment.name,
                    if (attachment.size != null) 'size': attachment.size,
                  },
              ]),
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
              'attachments': _attachmentPayload(command.attachments),
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
              'attachments': _attachmentPayload(command.attachments),
          },
          options: Options(headers: {'Peon-Request-Id': command.commandId}),
        );
      }
      await (database.update(database.cachedSessions)..where(
            (row) =>
                row.workspaceId.equals(scope.workspaceId) &
                row.peonId.equals(scope.peonId) &
                row.sessionId.equals(scope.sessionId),
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
      final data = error.response?.data;
      final message = data is Map ? data['error'] as String? : null;
      throw FollowupException(
        message ?? 'Message could not be sent.',
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

  String _queueError(DioException error, String fallback) {
    final data = error.response?.data;
    return data is Map && data['error'] is String
        ? data['error'] as String
        : fallback;
  }

  QueuedFollowup _queuedFromJson(Map<String, dynamic> json) {
    final id = json['id'];
    if (id is! String || id.isEmpty) {
      throw const FormatException('Missing queue item id');
    }
    final rawAttachments = json['attachments'];
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
      permissionMode: json['permissionMode'] as String?,
      author: json['author'] as String?,
      model: json['model'] as String?,
      reasoningEffort: json['reasoningEffort'] as String?,
      commandId: json['commandId'] as String?,
      queuedAt: (json['queuedAt'] as num?)?.toDouble() ?? 0,
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
    'permissionMode': item.permissionMode,
    'author': item.author,
    'model': item.model,
    'reasoningEffort': item.reasoningEffort,
    'commandId': item.commandId,
    'queuedAt': item.queuedAt,
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
      agent: row.agent,
      model: row.model,
      reasoningEffort: row.reasoningEffort,
      attachments: _pendingAttachments(row.attachmentsJson),
    );
  }

  Future<List<FollowupAttachment>> _uploadAttachments({
    required FollowupScope scope,
    required String commandId,
    required List<NewSessionAttachment> attachments,
    required FollowupProgressCallback? onProgress,
  }) async {
    final uploaded = <FollowupAttachment>[];
    final usedNames = <String>{};
    for (var index = 0; index < attachments.length; index++) {
      final attachment = attachments[index];
      final name = _uniqueUploadName(attachment.name, usedNames);
      onProgress?.call(
        FollowupSubmissionProgress.uploading(
          current: index + 1,
          total: attachments.length,
          fileName: attachment.name,
        ),
      );
      try {
        final response = await _dio.put<Map<String, dynamic>>(
          'workspaces/${Uri.encodeComponent(scope.workspaceId)}'
          '/peons/${Uri.encodeComponent(scope.peonId)}'
          '/files/uploads/${Uri.encodeComponent(commandId)}'
          '/${Uri.encodeComponent(name)}',
          data: attachment.bytes,
          options: Options(
            headers: {
              'Content-Type': 'application/octet-stream',
              'Peon-Content-Sha256': sha256
                  .convert(attachment.bytes)
                  .toString(),
            },
          ),
        );
        final path = response.data?['path'] as String?;
        final transferId = response.data?['transferId'] as String?;
        final size = (response.data?['size'] as num?)?.toInt();
        final committedSha256 = response.data?['sha256'] as String?;
        if (path == null ||
            path.isEmpty ||
            (transferId != null &&
                (size != attachment.bytes.length || committedSha256 == null))) {
          throw FollowupException(
            'Overseer returned an invalid upload response for '
            '${attachment.name}.',
          );
        }
        uploaded.add(
          FollowupAttachment(
            type: attachment.type,
            path: path,
            name: attachment.name,
            size: attachment.bytes.length,
            transferId: transferId,
            sha256: committedSha256,
          ),
        );
      } on DioException catch (error) {
        final data = error.response?.data;
        final message = data is Map ? data['error'] as String? : null;
        throw FollowupException(
          message ??
              'Could not upload ${attachment.name}. Press Send to retry.',
          statusCode: error.response?.statusCode,
        );
      }
    }
    return uploaded;
  }

  List<Map<String, Object>> _attachmentPayload(
    List<FollowupAttachment> attachments,
  ) => [
    for (final attachment in attachments)
      {
        'type': attachment.type,
        'path': attachment.path,
        if (attachment.transferId != null) 'transferId': attachment.transferId!,
        if (attachment.size != null) 'size': attachment.size!,
        if (attachment.sha256 != null) 'sha256': attachment.sha256!,
      },
  ];

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

  String _commandId() {
    final bytes = List<int>.generate(16, (_) => _random.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    String hex(int start, int end) => bytes
        .sublist(start, end)
        .map((value) => value.toRadixString(16).padLeft(2, '0'))
        .join();
    return '${hex(0, 4)}-${hex(4, 6)}-${hex(6, 8)}-'
        '${hex(8, 10)}-${hex(10, 16)}';
  }
}

String _uniqueUploadName(String original, Set<String> used) {
  final sanitized = original.replaceAll(RegExp(r'[^\w.-]+'), '_');
  final base = sanitized.isEmpty ? 'file' : sanitized;
  if (used.add(base)) return base;
  final dot = base.lastIndexOf('.');
  final stem = dot > 0 ? base.substring(0, dot) : base;
  final extension = dot > 0 ? base.substring(dot) : '';
  var suffix = 2;
  while (!used.add('$stem-$suffix$extension')) {
    suffix++;
  }
  return '$stem-$suffix$extension';
}
