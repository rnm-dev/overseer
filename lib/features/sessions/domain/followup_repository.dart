import 'new_session_repository.dart';

class FollowupScope {
  const FollowupScope({
    required this.workspaceId,
    required this.peonId,
    required this.sessionId,
  });

  final String workspaceId;
  final String peonId;
  final String sessionId;

  @override
  bool operator ==(Object other) =>
      other is FollowupScope &&
      other.workspaceId == workspaceId &&
      other.peonId == peonId &&
      other.sessionId == sessionId;

  @override
  int get hashCode => Object.hash(workspaceId, peonId, sessionId);
}

class PendingFollowup {
  const PendingFollowup({
    required this.commandId,
    required this.scope,
    required this.prompt,
    required this.serverQueue,
    required this.startNow,
    required this.createdAt,
    this.agent,
    this.model,
    this.reasoningEffort,
    this.attachments = const [],
  });

  final String commandId;
  final FollowupScope scope;
  final String prompt;
  final bool serverQueue;
  final bool startNow;
  final double createdAt;
  final String? agent;
  final String? model;
  final String? reasoningEffort;
  final List<FollowupAttachment> attachments;
}

class FollowupAttachment {
  const FollowupAttachment({
    required this.type,
    required this.path,
    this.name,
    this.size,
  });

  final String type;
  final String path;
  final String? name;
  final int? size;
}

enum FollowupSubmissionStage { uploading, submitting }

class FollowupSubmissionProgress {
  const FollowupSubmissionProgress.uploading({
    required this.current,
    required this.total,
    required this.fileName,
  }) : stage = FollowupSubmissionStage.uploading;

  const FollowupSubmissionProgress.submitting()
    : stage = FollowupSubmissionStage.submitting,
      current = 0,
      total = 0,
      fileName = null;

  final FollowupSubmissionStage stage;
  final int current;
  final int total;
  final String? fileName;
}

typedef FollowupProgressCallback =
    void Function(FollowupSubmissionProgress progress);

class QueuedFollowupAttachment {
  const QueuedFollowupAttachment({
    required this.type,
    this.path,
    this.name,
    this.size,
  });

  final String type;
  final String? path;
  final String? name;
  final int? size;

  String get label {
    final explicitName = name?.trim();
    if (explicitName != null && explicitName.isNotEmpty) return explicitName;
    final attachmentPath = path?.trim();
    if (attachmentPath == null || attachmentPath.isEmpty) {
      return type == 'image' ? 'image' : 'file';
    }
    final parts = attachmentPath
        .split(RegExp(r'[/\\]'))
        .where((part) => part.isNotEmpty);
    return parts.isEmpty ? attachmentPath : parts.last;
  }
}

class QueuedFollowup {
  const QueuedFollowup({
    required this.id,
    required this.sessionId,
    required this.prompt,
    required this.queuedAt,
    this.attachments = const [],
    this.permissionMode,
    this.author,
    this.model,
    this.reasoningEffort,
    this.commandId,
  });

  final String id;
  final String sessionId;
  final String prompt;
  final List<QueuedFollowupAttachment> attachments;
  final String? permissionMode;
  final String? author;
  final String? model;
  final String? reasoningEffort;
  final String? commandId;
  final double queuedAt;
}

enum FollowupDelivery { delivered, queued }

class ModelCatalogOption {
  const ModelCatalogOption({
    required this.id,
    required this.label,
    this.alias,
    this.isDefault = false,
  });

  final String id;
  final String label;
  final String? alias;
  final bool isDefault;
}

class ModelProvider {
  const ModelProvider({
    required this.agent,
    required this.label,
    required this.models,
    required this.reasoningEfforts,
  });

  final String agent;
  final String label;
  final List<ModelCatalogOption> models;
  final List<ModelCatalogOption> reasoningEfforts;
}

class ModelsCatalog {
  const ModelsCatalog({
    required this.providers,
    this.defaultModel,
    this.defaultAgent,
  });

  final List<ModelProvider> providers;
  final String? defaultModel;
  final String? defaultAgent;
}

abstract interface class FollowupRepository {
  Future<String> loadDraft(FollowupScope scope);
  Future<void> saveDraft(FollowupScope scope, String text);
  Stream<List<PendingFollowup>> watchPending(FollowupScope scope);
  Stream<List<QueuedFollowup>> watchQueue(FollowupScope scope);
  Future<void> refreshQueue(FollowupScope scope);
  Future<void> removeQueued(FollowupScope scope, String itemId);
  Future<void> sendQueuedNow(FollowupScope scope, String itemId);
  Future<ModelsCatalog?> fetchModelCatalog(FollowupScope scope);

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
  });

  Future<bool> retryPending(FollowupScope scope);
}

class FollowupException implements Exception {
  const FollowupException(this.message, {this.statusCode, this.code});

  final String message;
  final int? statusCode;
  final String? code;

  @override
  String toString() => message;
}
