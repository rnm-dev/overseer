part of 'web_socket_fleet_live_service.dart';

class _WorkspaceSocket {
  _WorkspaceSocket({required this.cursor});

  WebSocketChannel? channel;
  StreamSubscription<Object?>? subscription;
  ScheduledTask? heartbeat;
  ScheduledTask? retryTimer;
  DateTime lastReceivedAt = DateTime.fromMillisecondsSinceEpoch(0);
  int cursor;
  Future<void> messageQueue = Future.value();
  int attempt = 0;
  bool connecting = false;
  bool reconnecting = false;
  bool ready = false;
  bool activeSeeded = false;
  bool activeSeedComplete = false;
  int activeReplayEndsRemaining = 0;
  int activeSeedGeneration = 0;
  PresenceLocation location = const PresenceLocation.workspace();
  final Set<String> peonIds = {};
  final Map<String, _SessionState> sessions = {};
  final List<Map<String, dynamic>> pendingSessions = [];
  final Map<String, _TailHandler> tails = {};
}

class _TailHandler {
  _TailHandler({
    required this.peonId,
    required this.sessionId,
    required this.lastEventId,
    required this.onFrame,
  });

  final String peonId;
  final String sessionId;
  final Future<void> Function(TranscriptTailFrame frame) onFrame;
  String? lastEventId;
  int attempt = 0;
  ScheduledTask? retryTimer;
}

class _SessionState {
  const _SessionState({
    required this.peonId,
    required this.sessionId,
    required this.status,
    required this.projectId,
    required this.projectKey,
    required this.syncedAt,
    this.title,
    this.promptPreview,
    this.preview,
    this.author,
    this.startedAt,
    this.lastActivityAt,
  });

  final String peonId;
  final String sessionId;
  final String? status;
  final String? projectId;
  final String? projectKey;
  final double syncedAt;
  final String? title;
  final String? promptPreview;
  final String? preview;
  final String? author;
  final double? startedAt;
  final double? lastActivityAt;
}
