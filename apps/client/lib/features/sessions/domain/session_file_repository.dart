import 'dart:typed_data';

abstract interface class SessionFileRepository {
  Future<SessionFilePreview> fetchArtifact({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String path,
  });

  Future<SessionFilePreview> fetchAttachment({
    required String workspaceId,
    required String peonId,
    required String path,
    required String name,
    String? type,
  });
}

class SessionFilePreview {
  const SessionFilePreview({
    required this.path,
    required this.bytes,
    this.contentType,
    this.truncated = false,
  });

  final String path;
  final Uint8List bytes;
  final String? contentType;
  final bool truncated;
}

class SessionFileException implements Exception {
  const SessionFileException(this.message);

  final String message;

  @override
  String toString() => message;
}
