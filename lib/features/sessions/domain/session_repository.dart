import '../../../core/live/live_projection_sink.dart';
import 'session_models.dart';

abstract interface class SessionRepository implements LiveProjectionSink {
  Future<List<SessionSummary>> loadCachedSessions({
    required String workspaceId,
    required String peonId,
  });

  Stream<List<SessionSummary>> watchSessions({
    required String workspaceId,
    required String peonId,
  });

  Future<SessionPage> fetchPage({
    required String workspaceId,
    required String peonId,
    required int offset,
    int limit = 50,
  });

  Future<SessionDetails> fetchDetails({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  });

  Future<void> cancelSession({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  });

  Future<TranscriptCache> loadCachedTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  });

  Stream<List<TranscriptEvent>> watchTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  });

  Future<TranscriptPage> fetchLatestTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    int limit = 50,
  });

  Future<TranscriptPage> fetchOlderTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String cursor,
    int limit = 50,
  });

  Future<void> cacheTailEvent({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String eventId,
    required Map<String, dynamic> payload,
  });
}
