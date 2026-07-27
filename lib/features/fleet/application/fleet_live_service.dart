import '../../../core/live/active_sessions.dart';
import '../../../core/live/presence.dart';

abstract interface class FleetLiveService {
  Future<void> connect({
    required List<String> workspaceIds,
    required Map<String, int> initialCursors,
    required void Function(String workspaceId, Map<String, dynamic> peon)
    onPeon,
    required Future<void> Function(
      String workspaceId,
      int cursor,
      Map<String, dynamic> session,
    )
    onSession,
    required Future<void> Function(
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
}

abstract interface class AttentionFleetLiveService {
  void setAttentionHandler(
    Future<void> Function(
      String workspaceId,
      int cursor,
      Map<String, dynamic> attention,
    )
    handler,
  );
}

abstract interface class FleetWorkspaceReconciler {
  Future<void> reconcileWorkspaces({
    required List<String> workspaceIds,
    required Map<String, int> initialCursors,
  });
}

abstract interface class FleetLiveLifecycle {
  Future<void> resumeFromBackground();
}
