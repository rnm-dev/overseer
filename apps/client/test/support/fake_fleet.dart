import 'package:overseer_mobile/core/live/active_sessions.dart';
import 'package:overseer_mobile/core/live/presence.dart';
import 'package:overseer_mobile/core/live/transcript_live_service.dart';
import 'package:overseer_mobile/features/fleet/application/fleet_live_service.dart';
import 'package:overseer_mobile/features/fleet/domain/fleet_models.dart';
import 'package:overseer_mobile/features/fleet/domain/fleet_repository.dart';

/// No-op [FleetLiveService]; tests override only the calls they observe.
class NoopFleetLiveService implements FleetLiveService {
  @override
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
  }) async {}

  @override
  void setPresence({
    required String workspaceId,
    required PresenceLocation location,
  }) {}

  @override
  Future<void> stop() async {}

  @override
  void setAttentionHandler(
    Future<void> Function(
      String workspaceId,
      int cursor,
      Map<String, dynamic> attention,
    )
    handler,
  ) {}

  @override
  Future<void> reconcileWorkspaces({
    required List<String> workspaceIds,
    required Map<String, int> initialCursors,
  }) async {}

  @override
  Future<void> resumeFromBackground() async {}

  @override
  void setForeground(bool foreground) {}

  @override
  void subscribeTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String? lastEventId,
    required Future<void> Function(TranscriptTailFrame frame) onFrame,
  }) {}

  @override
  void unsubscribeTranscript({
    required String workspaceId,
    required String sessionId,
  }) {}
}

/// [FleetRepository] with an empty cache, so the controller always awaits
/// [refreshFleet]; subclasses override it to supply a fleet.
class FakeFleetRepository implements FleetRepository {
  const FakeFleetRepository();

  @override
  Future<List<WorkspaceFleet>> loadCachedFleet() async => const [];

  @override
  Stream<List<WorkspaceFleet>> watchFleet() => const Stream.empty();

  @override
  Future<List<WorkspaceFleet>> refreshFleet() async => const [];

  @override
  Future<void> applyPeonProjection({
    required String workspaceId,
    required int cursor,
    required Map<String, dynamic> projection,
  }) async {}
}
