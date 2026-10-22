import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:drift/drift.dart';

import '../../../core/database/app_database.dart';
import '../../../core/network/server_error_message.dart';
import '../domain/followup_repository.dart';
import '../domain/new_session_repository.dart';

export '../../../core/network/server_error_message.dart';

/// Matches rows keyed by the (workspace_id, peon_id, session_id) triple.
Expression<bool> _matchesSessionKey(
  ({
    GeneratedColumn<String> workspaceId,
    GeneratedColumn<String> peonId,
    GeneratedColumn<String> sessionId,
  })
  columns,
  String workspaceId,
  String peonId,
  String sessionId,
) =>
    columns.workspaceId.equals(workspaceId) &
    columns.peonId.equals(peonId) &
    columns.sessionId.equals(sessionId);

// Drift generates unrelated table classes, so each session-keyed table gets a
// typed one-line `matchesSession` over the shared filter above.

extension CachedSessionsKey on $CachedSessionsTable {
  Expression<bool> matchesSession(String w, String p, String s) =>
      _matchesSessionKey(
        (workspaceId: workspaceId, peonId: peonId, sessionId: sessionId),
        w,
        p,
        s,
      );
}

extension CachedTranscriptsKey on $CachedTranscriptsTable {
  Expression<bool> matchesSession(String w, String p, String s) =>
      _matchesSessionKey(
        (workspaceId: workspaceId, peonId: peonId, sessionId: sessionId),
        w,
        p,
        s,
      );
}

extension CachedTranscriptEventsKey on $CachedTranscriptEventsTable {
  Expression<bool> matchesSession(String w, String p, String s) =>
      _matchesSessionKey(
        (workspaceId: workspaceId, peonId: peonId, sessionId: sessionId),
        w,
        p,
        s,
      );
}

extension ComposerDraftsKey on $ComposerDraftsTable {
  Expression<bool> matchesSession(String w, String p, String s) =>
      _matchesSessionKey(
        (workspaceId: workspaceId, peonId: peonId, sessionId: sessionId),
        w,
        p,
        s,
      );
}

extension PendingFollowupCommandsKey on $PendingFollowupCommandsTable {
  Expression<bool> matchesSession(String w, String p, String s) =>
      _matchesSessionKey(
        (workspaceId: workspaceId, peonId: peonId, sessionId: sessionId),
        w,
        p,
        s,
      );
}

extension CachedQueuedFollowupsKey on $CachedQueuedFollowupsTable {
  Expression<bool> matchesSession(String w, String p, String s) =>
      _matchesSessionKey(
        (workspaceId: workspaceId, peonId: peonId, sessionId: sessionId),
        w,
        p,
        s,
      );
}

/// Uploads composer attachments to the Peon's staging area under [uploadId]
/// and returns the committed descriptors. Each `size` is the server-reported
/// size unless [reportLocalSize] asks for the local byte count instead.
Future<List<FollowupAttachment>> uploadAttachments({
  required Dio dio,
  required String workspaceId,
  required String peonId,
  required String uploadId,
  required List<NewSessionAttachment> attachments,
  required Exception Function(String message, int? statusCode) error,
  bool reportLocalSize = false,
  void Function(int current, int total, String fileName)? onUploading,
}) async {
  final uploaded = <FollowupAttachment>[];
  final usedNames = <String>{};
  for (var index = 0; index < attachments.length; index++) {
    final attachment = attachments[index];
    final name = _uniqueUploadName(attachment.name, usedNames);
    onUploading?.call(index + 1, attachments.length, attachment.name);
    late final Response<Map<String, dynamic>> response;
    try {
      response = await dio.put<Map<String, dynamic>>(
        'workspaces/${Uri.encodeComponent(workspaceId)}'
        '/peons/${Uri.encodeComponent(peonId)}'
        '/files/uploads/${Uri.encodeComponent(uploadId)}'
        '/${Uri.encodeComponent(name)}',
        data: attachment.bytes,
        options: Options(
          headers: {
            'Content-Type': 'application/octet-stream',
            'Peon-Content-Sha256': sha256.convert(attachment.bytes).toString(),
          },
        ),
      );
    } on DioException catch (dioError) {
      throw error(
        dioError.serverMessage ??
            'Could not upload ${attachment.name}. Press Send to retry.',
        dioError.response?.statusCode,
      );
    }
    final path = response.data?['path'] as String?;
    final transferId = response.data?['transferId'] as String?;
    final size = (response.data?['size'] as num?)?.toInt();
    final committedSha256 = response.data?['sha256'] as String?;
    if (path == null ||
        path.isEmpty ||
        (transferId != null &&
            (size != attachment.bytes.length || committedSha256 == null))) {
      throw error(
        'Overseer returned an invalid upload response for '
        '${attachment.name}.',
        null,
      );
    }
    uploaded.add(
      FollowupAttachment(
        type: attachment.type,
        path: path,
        name: attachment.name,
        size: reportLocalSize ? attachment.bytes.length : size,
        transferId: transferId,
        sha256: committedSha256,
      ),
    );
  }
  return uploaded;
}

/// The wire shape of an uploaded attachment reference.
List<Map<String, Object>> attachmentPayload(
  List<FollowupAttachment> attachments,
) => [
  for (final attachment in attachments)
    {
      'type': attachment.type,
      'path': attachment.path,
      'transferId': ?attachment.transferId,
      'size': ?attachment.size,
      'sha256': ?attachment.sha256,
    },
];

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
