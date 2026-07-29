class TranscriptTailFrame {
  const TranscriptTailFrame.event({
    required this.eventId,
    required this.data,
    this.event,
  }) : error = null,
       retryable = true,
       terminal = false;

  const TranscriptTailFrame.terminal({required this.retryable, this.error})
    : eventId = null,
      data = '',
      event = null,
      terminal = true;

  final String? eventId;
  final String? event;
  final String data;
  final String? error;
  final bool retryable;
  final bool terminal;
}

abstract interface class TranscriptLiveService {
  void subscribeTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String? lastEventId,
    required Future<void> Function(TranscriptTailFrame frame) onFrame,
  });

  void unsubscribeTranscript({
    required String workspaceId,
    required String sessionId,
  });
}
