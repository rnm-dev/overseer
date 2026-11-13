class TranscriptTailFrame {
  const TranscriptTailFrame.event({
    required this.eventId,
    required this.data,
    this.event,
  }) : error = null,
       retryable = true,
       terminal = false,
       reconnected = false;

  const TranscriptTailFrame.terminal({required this.retryable, this.error})
    : eventId = null,
      data = '',
      event = null,
      terminal = true,
      reconnected = false;

  /// The workspace socket reconnected and the tail was NOT resubscribed.
  ///
  /// The handler's last applied `eventId` may be arbitrarily old by now, and
  /// resuming after it would make Peon replay the whole missed gap oldest
  /// first. The owner reads the newest HTTP page instead and subscribes again
  /// from that boundary.
  const TranscriptTailFrame.reconnected()
    : eventId = null,
      data = '',
      event = null,
      error = null,
      retryable = true,
      terminal = false,
      reconnected = true;

  final String? eventId;
  final String? event;
  final String data;
  final String? error;
  final bool retryable;
  final bool terminal;
  final bool reconnected;
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
