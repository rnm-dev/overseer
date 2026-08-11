import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

import '../domain/session_file_repository.dart';

class DioSessionFileRepository implements SessionFileRepository {
  DioSessionFileRepository({required this._dio});

  final Dio _dio;

  @override
  Future<SessionFilePreview> fetchArtifact({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String path,
  }) async {
    final base = _sessionBase(workspaceId, peonId, sessionId);
    try {
      final metadata = await _dio.get<Map<String, dynamic>>(
        '$base/file',
        queryParameters: {'path': path},
      );
      final payload = metadata.data;
      if (payload == null) {
        throw const FormatException('Invalid session file response');
      }
      final binary = payload['binary'] == true;
      final content = payload['content'];
      final shouldFetchRaw = binary || _isMediaPath(path) || content is! String;
      if (shouldFetchRaw) {
        final raw = await _dio.get<List<int>>(
          '$base/file/raw',
          queryParameters: {'path': path},
          options: Options(responseType: ResponseType.bytes),
        );
        return SessionFilePreview(
          path: path,
          bytes: Uint8List.fromList(raw.data ?? const []),
          contentType: raw.headers.value(Headers.contentTypeHeader),
          truncated: payload['truncated'] == true,
        );
      }
      return SessionFilePreview(
        path: path,
        bytes: Uint8List.fromList(utf8.encode(content)),
        contentType: _contentTypeForPath(path),
        truncated: payload['truncated'] == true,
      );
    } on DioException catch (error) {
      throw SessionFileException(_message(error, 'Could not open this file.'));
    } on FormatException {
      throw const SessionFileException(
        'Overseer returned an invalid file preview.',
      );
    }
  }

  @override
  Future<SessionFilePreview> fetchAttachment({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String path,
    required String name,
    String? type,
  }) async {
    // Peon persists resolved absolute attachment paths in durable transcript
    // events. Those paths cannot be read through the transfer-root `/files`
    // endpoint, but the session-scoped file API intentionally accepts them.
    if (_isAbsolutePath(path)) {
      final preview = await fetchArtifact(
        workspaceId: workspaceId,
        peonId: peonId,
        sessionId: sessionId,
        path: path,
      );
      return SessionFilePreview(
        path: name,
        bytes: preview.bytes,
        contentType:
            preview.contentType ??
            (type == 'image' ? 'image/*' : _contentTypeForPath(name)),
        truncated: preview.truncated,
      );
    }
    final encoded = path
        .split(RegExp(r'[/\\]'))
        .where((segment) => segment.isNotEmpty)
        .map(Uri.encodeComponent)
        .join('/');
    try {
      final response = await _dio.get<List<int>>(
        'workspaces/${Uri.encodeComponent(workspaceId)}/peons/'
        '${Uri.encodeComponent(peonId)}/files/$encoded',
        options: Options(responseType: ResponseType.bytes),
      );
      return SessionFilePreview(
        path: name,
        bytes: Uint8List.fromList(response.data ?? const []),
        contentType:
            response.headers.value(Headers.contentTypeHeader) ??
            (type == 'image' ? 'image/*' : _contentTypeForPath(name)),
      );
    } on DioException catch (error) {
      throw SessionFileException(
        _message(error, 'Could not open this attachment.'),
      );
    }
  }

  String _sessionBase(String workspaceId, String peonId, String sessionId) =>
      'workspaces/${Uri.encodeComponent(workspaceId)}/peons/'
      '${Uri.encodeComponent(peonId)}/sessions/'
      '${Uri.encodeComponent(sessionId)}';
}

bool _isAbsolutePath(String path) =>
    path.startsWith('/') ||
    path.startsWith(r'\\') ||
    RegExp(r'^[A-Za-z]:[/\\]').hasMatch(path);

bool _isMediaPath(String path) => RegExp(
  r'\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico|pdf)$',
  caseSensitive: false,
).hasMatch(path);

String? _contentTypeForPath(String path) {
  final lower = path.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  if (lower.endsWith('.md') ||
      lower.endsWith('.markdown') ||
      lower.endsWith('.mdx')) {
    return 'text/markdown';
  }
  if (lower.endsWith('.json')) return 'application/json';
  return 'text/plain';
}

String _message(DioException error, String fallback) {
  final data = error.response?.data;
  return data is Map && data['error'] is String
      ? data['error'] as String
      : fallback;
}
