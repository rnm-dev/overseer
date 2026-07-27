import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:drift/drift.dart';

import '../../../core/database/app_database.dart';
import '../../../core/network/overseer_http_client.dart';
import '../../../core/time/app_time.dart';
import '../domain/new_session_repository.dart';
import '../domain/session_models.dart';

class DefaultNewSessionRepository implements NewSessionRepository {
  DefaultNewSessionRepository({
    required this.database,
    required Uri apiUrl,
    required String token,
    Dio? dio,
    this._clock = const SystemAppClock(),
  }) : _dio = dio ?? createOverseerHttpClient(apiUrl: apiUrl, token: token);

  final AppDatabase database;
  final Dio _dio;
  final AppClock _clock;

  @override
  Future<SessionSummary> createSession(NewSessionRequest request) async {
    try {
      final attachments = <Map<String, String>>[];
      final usedUploadNames = <String>{};
      for (var index = 0; index < request.attachments.length; index++) {
        final attachment = request.attachments[index];
        final name = _uniqueUploadName(attachment.name, usedUploadNames);
        request.onProgress?.call(
          NewSessionSubmissionProgress.uploading(
            current: index + 1,
            total: request.attachments.length,
            fileName: attachment.name,
          ),
        );
        late final Response<Map<String, dynamic>> response;
        try {
          response = await _dio.put<Map<String, dynamic>>(
            'workspaces/${Uri.encodeComponent(request.workspaceId)}'
            '/peons/${Uri.encodeComponent(request.peonId)}'
            '/files/uploads/${Uri.encodeComponent(request.requestId)}'
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
        } on DioException catch (error) {
          throw NewSessionException(
            _serverMessage(error) ??
                'Could not upload ${attachment.name}. Press Send to retry.',
          );
        }
        final path = response.data?['path'] as String?;
        if (path == null || path.isEmpty) {
          throw NewSessionException(
            'Overseer returned an invalid upload response for '
            '${attachment.name}.',
          );
        }
        attachments.add({'type': attachment.type, 'path': path});
      }
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
          _serverMessage(error) ??
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
      final session = SessionSummary(
        workspaceId: request.workspaceId,
        peonId: request.peonId,
        sessionId: sessionId,
        status: 'running',
        projectKey: request.projectKey,
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
      await database
          .into(database.cachedSessions)
          .insertOnConflictUpdate(
            CachedSessionsCompanion.insert(
              workspaceId: session.workspaceId,
              peonId: session.peonId,
              sessionId: session.sessionId,
              status: Value(session.status),
              projectKey: Value(session.projectKey),
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

String _uniqueUploadName(String rawName, Set<String> usedNames) {
  final safeName = rawName.replaceAll(RegExp(r'[^\w.-]+'), '_').trim();
  final baseName = safeName.isEmpty ? 'file' : safeName;
  var candidate = baseName;
  var suffix = 2;
  while (!usedNames.add(candidate.toLowerCase())) {
    final dot = baseName.lastIndexOf('.');
    final hasExtension = dot > 0 && dot < baseName.length - 1;
    final stem = hasExtension ? baseName.substring(0, dot) : baseName;
    final extension = hasExtension ? baseName.substring(dot) : '';
    candidate = '$stem-$suffix$extension';
    suffix++;
  }
  return candidate;
}

String? _serverMessage(DioException error) {
  final data = error.response?.data;
  return data is Map ? data['error'] as String? : null;
}
