import 'dart:typed_data';

import 'session_models.dart';

class NewSessionAttachment {
  const NewSessionAttachment({
    required this.name,
    required this.type,
    required this.bytes,
  });

  final String name;
  final String type;
  final Uint8List bytes;
}

enum NewSessionSubmissionStage { uploading, starting }

class NewSessionSubmissionProgress {
  const NewSessionSubmissionProgress.uploading({
    required this.current,
    required this.total,
    required this.fileName,
  }) : stage = NewSessionSubmissionStage.uploading;

  const NewSessionSubmissionProgress.starting()
    : stage = NewSessionSubmissionStage.starting,
      current = 0,
      total = 0,
      fileName = null;

  final NewSessionSubmissionStage stage;
  final int current;
  final int total;
  final String? fileName;
}

typedef NewSessionProgressCallback =
    void Function(NewSessionSubmissionProgress progress);

class NewSessionRequest {
  const NewSessionRequest({
    required this.workspaceId,
    required this.peonId,
    required this.requestId,
    required this.prompt,
    this.projectKey,
    this.dir,
    this.agent,
    this.model,
    this.reasoningEffort,
    this.attachments = const [],
    this.onProgress,
  });

  final String workspaceId;
  final String peonId;
  final String requestId;
  final String prompt;
  final String? projectKey;
  final String? dir;
  final String? agent;
  final String? model;
  final String? reasoningEffort;
  final List<NewSessionAttachment> attachments;
  final NewSessionProgressCallback? onProgress;
}

abstract interface class NewSessionRepository {
  Future<SessionSummary> createSession(NewSessionRequest request);
}

class NewSessionException implements Exception {
  const NewSessionException(this.message);

  final String message;

  @override
  String toString() => message;
}
