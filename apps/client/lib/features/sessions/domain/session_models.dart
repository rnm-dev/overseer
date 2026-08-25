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

class SelectedTextReply {
  const SelectedTextReply({required this.eventId, required this.selectedText});

  final String eventId;
  final String selectedText;

  factory SelectedTextReply.fromJson(Object? value) {
    if (value is! Map) {
      throw const FormatException('Invalid selected-text reply');
    }
    final eventId = value['eventId'];
    final selectedText = value['selectedText'];
    if (eventId is! String ||
        eventId.isEmpty ||
        selectedText is! String ||
        selectedText.trim().isEmpty) {
      throw const FormatException('Invalid selected-text reply');
    }
    return SelectedTextReply(eventId: eventId, selectedText: selectedText);
  }

  Map<String, dynamic> toJson() => {
    'eventId': eventId,
    'selectedText': selectedText,
  };

  @override
  bool operator ==(Object other) =>
      other is SelectedTextReply &&
      other.eventId == eventId &&
      other.selectedText == selectedText;

  @override
  int get hashCode => Object.hash(eventId, selectedText);
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

  SelectedTextReply? get replyTo {
    final raw = payload['replyTo'];
    if (raw == null) return null;
    try {
      return SelectedTextReply.fromJson(raw);
    } on FormatException {
      return null;
    }
  }

  bool get isUserMessage =>
      type == 'user_message' ||
      (type == 'user' && _messageRole(payload) == 'user');

  static String? _messageRole(Map<String, dynamic> payload) {
    final message = payload['message'];
    return message is Map ? message['role'] as String? : null;
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
