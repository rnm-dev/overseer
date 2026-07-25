import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/live/active_sessions.dart';
import '../../../core/live/live_projection_sink.dart';
import '../../../core/live/presence.dart';
import '../../../core/notifications/notification_routing.dart';
import 'fleet_live_service.dart';
import '../domain/fleet_models.dart';
import '../domain/fleet_repository.dart';

final fleetRepositoryProvider = Provider<FleetRepository>(
  (ref) => throw StateError(
    'FleetRepository must be supplied by the application composition root.',
  ),
);

final fleetLiveServiceProvider = Provider<FleetLiveService?>((ref) => null);
final liveProjectionSinkProvider = Provider<LiveProjectionSink?>((ref) => null);
final projectLiveProjectionSinkProvider = Provider<LiveProjectionSink?>(
  (ref) => null,
);
final workspaceConnectionRecorderProvider =
    Provider<WorkspaceConnectionRecorder>(
      (ref) => const NoopWorkspaceConnectionRecorder(),
    );

final fleetControllerProvider =
    AsyncNotifierProvider.autoDispose<FleetController, List<WorkspaceFleet>>(
      FleetController.new,
      retry: (_, _) => null,
    );

class FleetController extends AsyncNotifier<List<WorkspaceFleet>> {
  @override
  Future<List<WorkspaceFleet>> build() async {
    final fleet = await ref.read(fleetRepositoryProvider).loadFleet();
    unawaited(
      ref
          .read(workspaceConnectionRecorderProvider)
          .recordWorkspaceIds(fleet.map((item) => item.workspace.id))
          .catchError((_) {}),
    );
    final live = ref.read(fleetLiveServiceProvider);
    if (live != null) {
      final sink = ref.read(liveProjectionSinkProvider);
      final projectSink = ref.read(projectLiveProjectionSinkProvider);
      final workspaceIds = fleet.map((item) => item.workspace.id).toList();
      final activeSessions = ref.read(activeSessionsProvider.notifier);
      for (final workspaceId in workspaceIds) {
        activeSessions.markUnknown(workspaceId);
      }
      final cursors = sink == null
          ? const <String, int>{}
          : {
              for (final workspaceId in workspaceIds)
                workspaceId: await sink.cursorFor(workspaceId),
            };
      ref.onDispose(() => unawaited(live.stop()));
      unawaited(
        live.connect(
          workspaceIds: workspaceIds,
          initialCursors: cursors,
          onPeon: _applyPeon,
          onSession: (workspaceId, cursor, session) async {
            await sink?.applyLiveProjection(
              workspaceId: workspaceId,
              cursor: cursor,
              projection: session,
            );
          },
          onProject: (workspaceId, cursor, project) async {
            await projectSink?.applyLiveProjection(
              workspaceId: workspaceId,
              cursor: cursor,
              projection: project,
            );
          },
          onCursor: (workspaceId, cursor) async {
            await sink?.advanceCursor(workspaceId: workspaceId, cursor: cursor);
          },
          onActiveSessions: _applyActiveSessions,
          onActiveSessionSnapshot: (workspaceId, sessions) {
            if (sessions == null) {
              activeSessions.markUnknown(workspaceId);
            } else {
              activeSessions.replaceWorkspace(workspaceId, sessions);
            }
          },
          onPresence: (workspaceId, presence) => ref
              .read(presenceProvider.notifier)
              .replaceWorkspace(workspaceId, presence),
        ),
      );
    }
    return fleet;
  }

  Future<void> refresh() async {
    state = await AsyncValue.guard(ref.read(fleetRepositoryProvider).loadFleet);
  }

  void _applyPeon(String workspaceId, Map<String, dynamic> projection) {
    final current = state.value;
    final peonId = projection['peonId'];
    if (current == null || peonId is! String) return;

    state = AsyncData([
      for (final fleet in current)
        if (fleet.workspace.id != workspaceId)
          fleet
        else
          WorkspaceFleet(
            workspace: fleet.workspace,
            peons: [
              for (final peon in fleet.peons)
                if (peon.id != peonId)
                  peon
                else
                  Peon(
                    id: peon.id,
                    name: projection['name'] as String? ?? peon.name,
                    hostname: peon.hostname,
                    baseUrl: peon.baseUrl,
                    addressSource: peon.addressSource,
                    online: projection['online'] as bool? ?? peon.online,
                    lastSeen: peon.lastSeen,
                    capabilities: peon.capabilities,
                    load: peon.load,
                  ),
            ],
          ),
    ]);
  }

  void _applyActiveSessions(
    String workspaceId,
    String peonId,
    int activeSessions,
  ) {
    final current = state.value;
    if (current == null) return;
    state = AsyncData([
      for (final fleet in current)
        if (fleet.workspace.id != workspaceId)
          fleet
        else
          WorkspaceFleet(
            workspace: fleet.workspace,
            peons: [
              for (final peon in fleet.peons)
                if (peon.id != peonId)
                  peon
                else
                  Peon(
                    id: peon.id,
                    name: peon.name,
                    hostname: peon.hostname,
                    baseUrl: peon.baseUrl,
                    addressSource: peon.addressSource,
                    online: peon.online,
                    lastSeen: peon.lastSeen,
                    capabilities: peon.capabilities,
                    load: PeonLoad(
                      activeSessions: activeSessions,
                      paused: peon.load?.paused,
                    ),
                  ),
            ],
          ),
    ]);
  }
}
