class SessionSummary {
  const SessionSummary({
    required this.workspaceId,
    required this.peonId,
    required this.sessionId,
    required this.syncedAt,
    this.status,
    this.projectKey,
    this.projectId,
    this.title,
    this.promptPreview,
    this.preview,
    this.author,
    this.outcomeJson,
    this.startedAt,
    this.endedAt,
    this.lastActivityAt,
    this.attentionUnread = false,
    this.attentionUpdatedAt = 0,
    this.operatorRequested = false,
    this.hasOutstandingRequest = false,
    this.lastRequestedAt,
  });

  final String workspaceId;
  final String peonId;
  final String sessionId;
  final String? status;
  final String? projectKey;
  final String? projectId;
  final String? title;
  final String? promptPreview;
  final String? preview;
  final String? author;
  final String? outcomeJson;
  final double? startedAt;
  final double? endedAt;
  final double? lastActivityAt;
  final double syncedAt;
  final bool attentionUnread;
  final double attentionUpdatedAt;
  final bool operatorRequested;
  final bool hasOutstandingRequest;
  final double? lastRequestedAt;

  double get sortActivity => lastActivityAt ?? startedAt ?? 0;

  String get displayTitle {
    final candidates = [title, promptPreview, preview];
    for (final candidate in candidates) {
      if (candidate?.trim().isNotEmpty == true) return candidate!.trim();
    }
    return 'Untitled session';
  }

  String? get displayPreview {
    for (final candidate in [preview, promptPreview]) {
      final value = candidate?.trim();
      if (value != null && value.isNotEmpty && value != displayTitle) {
        return value;
      }
    }
    return null;
  }

  bool get isRunning => status == 'running';
}

class SessionPage {
  const SessionPage({
    required this.sessions,
    required this.total,
    required this.offset,
    required this.limit,
    required this.catalogStale,
  });

  final List<SessionSummary> sessions;
  final int total;
  final int offset;
  final int limit;
  final bool catalogStale;

  bool get hasMore => offset + sessions.length < total;
}

class SessionDetails {
  const SessionDetails({
    required this.turnCount,
    this.status,
    this.projectKey,
    this.projectId,
    this.projectRoot,
    this.usage,
    this.agent,
    this.model,
    this.reasoningEffort,
  });

  final int turnCount;
  final String? status;
  final String? projectKey;
  final String? projectId;
  final String? projectRoot;
  final SessionUsage? usage;
  final String? agent;
  final String? model;
  final String? reasoningEffort;
}

class SessionUsage {
  const SessionUsage({
    required this.inputTokens,
    required this.outputTokens,
    required this.cacheCreationInputTokens,
    required this.cacheReadInputTokens,
  });

  final int inputTokens;
  final int outputTokens;
  final int cacheCreationInputTokens;
  final int cacheReadInputTokens;
}

class TranscriptEvent {
  TranscriptEvent({
    required this.eventId,
    required this.orderKey,
    required Map<String, dynamic> payload,
  }) : payload = Map.unmodifiable(payload);

  final String eventId;
  final int orderKey;
  final Map<String, dynamic> payload;

  String? get type => payload['type'] as String?;
  double? get createdAt => (payload['createdAt'] as num?)?.toDouble();

  bool get isUserMessage =>
      type == 'user_message' ||
      (type == 'user' && _messageRole(payload) == 'user');

  String get displayText {
    final direct = payload['text'];
    if (direct is String && direct.trim().isNotEmpty) return direct.trim();

    final message = payload['message'];
    if (message is Map) {
      final text = _textFromContent(message['content']);
      if (text.isNotEmpty) return text;
    }

    final content = _textFromContent(payload['content']);
    if (content.isNotEmpty) return content;

    if (type == 'result') {
      final result = payload['is_error'] == true
          ? 'Run failed'
          : 'Run finished';
      final turns = (payload['num_turns'] as num?)?.toInt();
      return turns == null ? result : '$result · $turns turns';
    }
    if (type == 'system') return 'System update';
    return type?.replaceAll('_', ' ') ?? 'Transcript event';
  }

  static String? _messageRole(Map<String, dynamic> payload) {
    final message = payload['message'];
    return message is Map ? message['role'] as String? : null;
  }

  static String _textFromContent(Object? content) {
    if (content is String) return content.trim();
    if (content is! List) return '';
    final parts = <String>[];
    for (final item in content) {
      if (item is String && item.trim().isNotEmpty) {
        parts.add(item.trim());
        continue;
      }
      if (item is! Map) continue;
      final text = item['text'] ?? item['thinking'];
      if (text is String && text.trim().isNotEmpty) {
        parts.add(text.trim());
        continue;
      }
      final name = item['name'];
      if (item['type'] == 'tool_use' && name is String && name.isNotEmpty) {
        parts.add('Used $name');
      }
    }
    return parts.join('\n');
  }
}

class TranscriptCache {
  const TranscriptCache({required this.events, required this.hasOlder});

  final List<TranscriptEvent> events;
  final bool hasOlder;
}

class TranscriptPage {
  const TranscriptPage({
    required this.events,
    required this.nextCursor,
    required this.hasMore,
    required this.insertedCount,
  });

  final List<TranscriptEvent> events;
  final String? nextCursor;
  final bool hasMore;
  final int insertedCount;
}

class SessionsException implements Exception {
  const SessionsException(this.message);

  final String message;

  @override
  String toString() => message;
}
