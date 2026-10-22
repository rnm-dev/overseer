import '../../../core/live/active_sessions.dart';
import '../../../core/live/presence.dart';
import '../../../core/live/transcript_live_service.dart';

/// The single live socket also carries transcript tails, so it is usable
/// wherever a [TranscriptLiveService] is expected.
abstract interface class FleetLiveService implements TranscriptLiveService {
  Future<void> connect({
    required List<String> workspaceIds,
    required Map<String, int> initialCursors,
    required Future<bool> Function(
      String workspaceId,
      int cursor,
      Map<String, dynamic> peon,
    )
    onPeon,
    required Future<bool> Function(
      String workspaceId,
      int cursor,
      Map<String, dynamic> session,
    )
    onSession,
    required Future<bool> Function(
      String workspaceId,
      int cursor,
      Map<String, dynamic> project,
    )
    onProject,
    required Future<void> Function(String workspaceId, int cursor) onCursor,
    required void Function(
      String workspaceId,
      String peonId,
      int activeSessions,
    )
    onActiveSessions,
    required void Function(
      String workspaceId,
      List<ActiveSession>? activeSessions,
    )
    onActiveSessionSnapshot,
    required void Function(String workspaceId, List<PresenceEntry> presence)
    onPresence,
  });

  void setPresence({
    required String workspaceId,
    required PresenceLocation location,
  });

  Future<void> stop();

  void setAttentionHandler(
    Future<void> Function(
      String workspaceId,
      int cursor,
      Map<String, dynamic> attention,
    )
    handler,
  );

  Future<void> reconcileWorkspaces({
    required List<String> workspaceIds,
    required Map<String, int> initialCursors,
  });

  Future<void> resumeFromBackground();

  void setForeground(bool foreground);
}
