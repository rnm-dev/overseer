import 'package:dio/dio.dart';
import 'package:drift/drift.dart';

import '../../../core/database/app_database.dart';
import '../../../core/time/app_time.dart';
import '../domain/new_session_repository.dart';
import '../domain/session_models.dart';
import 'project_session_count_cache.dart';
import 'session_data_helpers.dart';

class DefaultNewSessionRepository implements NewSessionRepository {
  DefaultNewSessionRepository({
    required this.database,
    required this._dio,
    this._clock = const SystemAppClock(),
  });

  final AppDatabase database;
  final Dio _dio;
  final AppClock _clock;

  @override
  Future<SessionSummary> createSession(NewSessionRequest request) async {
    try {
      final attachments = attachmentPayload(
        await uploadAttachments(
          dio: _dio,
          workspaceId: request.workspaceId,
          peonId: request.peonId,
          uploadId: request.requestId,
          attachments: request.attachments,
          error: (message, _) => NewSessionException(message),
          onUploading: (current, total, fileName) => request.onProgress?.call(
            NewSessionSubmissionProgress.uploading(
              current: current,
              total: total,
              fileName: fileName,
            ),
          ),
        ),
      );
      request.onProgress?.call(const NewSessionSubmissionProgress.starting());
      late final Response<Map<String, dynamic>> response;
      try {
        response = await _dio.post<Map<String, dynamic>>(
          'workspaces/${Uri.encodeComponent(request.workspaceId)}'
          '/peons/${Uri.encodeComponent(request.peonId)}/sessions',
          data: <String, dynamic>{
            'prompt': request.prompt.trim().isEmpty
                ? '(see attachments)'
                : request.prompt.trim(),
            if (request.projectKey?.isNotEmpty == true)
              'projectKey': request.projectKey,
            if (request.dir?.trim().isNotEmpty == true)
              'dir': request.dir!.trim(),
            if (request.agent?.isNotEmpty == true) 'agent': request.agent,
            if (request.model?.isNotEmpty == true) 'model': request.model,
            if (request.reasoningEffort?.isNotEmpty == true)
              'reasoningEffort': request.reasoningEffort,
            if (attachments.isNotEmpty) 'attachments': attachments,
          },
          options: Options(headers: {'Peon-Request-Id': request.requestId}),
        );
      } on DioException catch (error) {
        throw NewSessionException(
          error.serverMessage ??
              'Session could not be started. Press Send to retry.',
        );
      }
      final payload = response.data;
      final nested = payload?['session'];
      final sessionId =
          payload?['id'] as String? ??
          (nested is Map ? nested['id'] as String? : null);
      if (sessionId == null || sessionId.isEmpty) {
        throw const FormatException('Invalid new session response');
      }
      final now = _clock.now().millisecondsSinceEpoch.toDouble();
      final responseSession = nested is Map
          ? Map<String, dynamic>.from(nested)
          : payload ?? const <String, dynamic>{};
      final session = SessionSummary(
        workspaceId: request.workspaceId,
        peonId: request.peonId,
        sessionId: sessionId,
        status: 'running',
        projectKey: request.projectKey,
        projectId: responseSession['projectId'] as String?,
        title: request.prompt.trim().isEmpty
            ? '(see attachments)'
            : request.prompt.trim(),
        promptPreview: request.prompt.trim().isEmpty
            ? '(see attachments)'
            : request.prompt.trim(),
        startedAt: now,
        lastActivityAt: now,
        syncedAt: now,
        operatorRequested: true,
        hasOutstandingRequest: true,
        lastRequestedAt: now,
      );
      await database.transaction(() async {
        final existing =
            await (database.select(database.cachedSessions)..where(
                  (row) => row.matchesSession(
                    session.workspaceId,
                    session.peonId,
                    session.sessionId,
                  ),
                ))
                .getSingleOrNull();
        await database
            .into(database.cachedSessions)
            .insertOnConflictUpdate(
              CachedSessionsCompanion.insert(
                workspaceId: session.workspaceId,
                peonId: session.peonId,
                sessionId: session.sessionId,
                status: Value(session.status),
                projectKey: Value(session.projectKey),
                projectId: Value(session.projectId),
                title: Value(session.title),
                promptPreview: Value(session.promptPreview),
                startedAt: Value(session.startedAt),
                lastActivityAt: Value(session.lastActivityAt),
                syncedAt: session.syncedAt,
                operatorRequested: const Value(true),
                hasOutstandingRequest: const Value(true),
                lastRequestedAt: Value(now),
              ),
            );
        if (existing == null) {
          await adjustCachedProjectSessionCount(
            database: database,
            workspaceId: session.workspaceId,
            peonId: session.peonId,
            projectId: session.projectId,
            projectKey: session.projectKey,
            delta: 1,
          );
        }
      });
      return session;
    } on FormatException {
      throw const NewSessionException(
        'Overseer returned an invalid new session response.',
      );
    } on TypeError {
      throw const NewSessionException(
        'Overseer returned an invalid new session response.',
      );
    }
  }
}
