import 'dart:convert';

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
    this.terminalReasonJson,
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

  /// Provider-neutral structured stop reason; decode by `code`, never message text.
  final String? terminalReasonJson;
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

  SessionTerminalReason? get terminalReason {
    if (terminalReasonJson == null) return null;
    try {
      final value = jsonDecode(terminalReasonJson!);
      return value is Map<String, dynamic>
          ? SessionTerminalReason.fromJson(value)
          : null;
    } on Object {
      return null;
    }
  }
}

class SessionTerminalReason {
  const SessionTerminalReason({
    required this.code,
    required this.message,
    required this.canResume,
    this.maxTurns,
    this.turnBudget,
    this.turnsUsed,
    this.timeoutMs,
    this.elapsedMs,
  });

  final String code;
  final String message;
  final bool canResume;
  final int? maxTurns;
  final int? turnBudget;
  final int? turnsUsed;
  final int? timeoutMs;
  final int? elapsedMs;

  factory SessionTerminalReason.fromJson(Map<String, dynamic> json) =>
      SessionTerminalReason(
        code: json['code'] as String? ?? 'unknown',
        message: json['message'] as String? ?? '',
        canResume: json['canResume'] as bool? ?? false,
        maxTurns: (json['maxTurns'] as num?)?.toInt(),
        turnBudget: (json['turnBudget'] as num?)?.toInt(),
        turnsUsed: (json['turnsUsed'] as num?)?.toInt(),
        timeoutMs: (json['timeoutMs'] as num?)?.toInt(),
        elapsedMs: (json['elapsedMs'] as num?)?.toInt(),
      );
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

  static const capability = 'selected-text-replies-v1';
  static const maxSelectedTextCodePoints = 8192;
  static const maxSelectedTextUtf8Bytes = 16 * 1024;

  /// Builds reply metadata from a live selection without trimming or
  /// otherwise changing the text that will be sent to Peon.
  static SelectedTextReply? fromSelection({
    required String? eventId,
    required String? selectedText,
  }) {
    if (eventId == null ||
        !_eventIdPattern.hasMatch(eventId) ||
        selectedText == null ||
        selectedText.trim().isEmpty ||
        selectedText.runes.length > maxSelectedTextCodePoints ||
        utf8.encode(selectedText).length > maxSelectedTextUtf8Bytes) {
      return null;
    }
    return SelectedTextReply(eventId: eventId, selectedText: selectedText);
  }

  factory SelectedTextReply.fromJson(Object? value) {
    if (value is! Map) {
      throw const FormatException('Invalid selected-text reply');
    }
    final eventId = value['eventId'];
    final selectedText = value['selectedText'];
    final reply = fromSelection(
      eventId: eventId is String ? eventId : null,
      selectedText: selectedText is String ? selectedText : null,
    );
    if (reply == null) {
      throw const FormatException('Invalid selected-text reply');
    }
    return reply;
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

final _eventIdPattern = RegExp(r'^[A-Za-z0-9_-]{1,256}$');

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
