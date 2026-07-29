import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/live/active_sessions.dart';
import 'package:overseer_mobile/core/live/presence.dart';
import 'package:overseer_mobile/features/fleet/application/fleet_controller.dart';
import 'package:overseer_mobile/features/fleet/application/fleet_live_service.dart';
import 'package:overseer_mobile/features/fleet/domain/fleet_models.dart';
import 'package:overseer_mobile/features/fleet/domain/fleet_repository.dart';

void main() {
  test(
    'renders cached fleet and reconciles live workspaces after refresh',
    () async {
      final refresh = Completer<List<WorkspaceFleet>>();
      final repository = _CachedFleetRepository(refresh.future);
      final live = _RecordingLiveService();
      final container = ProviderContainer(
        overrides: [
          fleetRepositoryProvider.overrideWithValue(repository),
          fleetLiveServiceProvider.overrideWithValue(live),
        ],
      );
      addTearDown(container.dispose);
      addTearDown(repository.dispose);
      container.listen(fleetControllerProvider, (_, _) {});

      final fleet = await container.read(fleetControllerProvider.future);
      expect(fleet.map((item) => item.workspace.id), ['workspace-1']);
      expect(refresh.isCompleted, isFalse);
      expect(live.connectedWorkspaceIds, ['workspace-1']);

      refresh.complete(const [
        WorkspaceFleet(
          workspace: Workspace(id: 'workspace-1', name: 'One'),
          peons: [],
        ),
        WorkspaceFleet(
          workspace: Workspace(id: 'workspace-2', name: 'Two'),
          peons: [],
        ),
      ]);
      repository.emit(await refresh.future);
      await _waitFor(() => live.reconciledWorkspaceIds.length == 2);

      expect(live.reconciledWorkspaceIds, ['workspace-1', 'workspace-2']);
      expect(
        container
            .read(fleetControllerProvider)
            .requireValue
            .map((item) => item.workspace.id),
        ['workspace-1', 'workspace-2'],
      );
    },
  );
}

const _cachedFleet = [
  WorkspaceFleet(
    workspace: Workspace(id: 'workspace-1', name: 'One'),
    peons: [Peon(id: 'peon-1', online: false, lastSeen: 0, capabilities: [])],
  ),
];

class _CachedFleetRepository implements CachedFleetRepository {
  _CachedFleetRepository(this.refreshResult);

  final Future<List<WorkspaceFleet>> refreshResult;
  final _changes = StreamController<List<WorkspaceFleet>>.broadcast();

  void emit(List<WorkspaceFleet> fleet) => _changes.add(fleet);

  Future<void> dispose() => _changes.close();

  @override
  Future<void> applyPeonProjection({
    required String workspaceId,
    required Map<String, dynamic> projection,
  }) async {}

  @override
  Future<List<WorkspaceFleet>> loadCachedFleet() async => _cachedFleet;

  @override
  Future<List<WorkspaceFleet>> loadFleet() => refreshFleet();

  @override
  Future<List<WorkspaceFleet>> refreshFleet() => refreshResult;

  @override
  Stream<List<WorkspaceFleet>> watchFleet() => _changes.stream;
}

class _RecordingLiveService
    implements FleetLiveService, FleetWorkspaceReconciler {
  List<String> connectedWorkspaceIds = const [];
  List<String> reconciledWorkspaceIds = const [];

  @override
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
  }) async {
    connectedWorkspaceIds = [...workspaceIds];
  }

  @override
  Future<void> reconcileWorkspaces({
    required List<String> workspaceIds,
    required Map<String, int> initialCursors,
  }) async {
    reconciledWorkspaceIds = [...workspaceIds];
  }

  @override
  void setPresence({
    required String workspaceId,
    required PresenceLocation location,
  }) {}

  @override
  Future<void> stop() async {}
}

Future<void> _waitFor(bool Function() condition) async {
  final deadline = DateTime.now().add(const Duration(seconds: 1));
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      fail('Timed out waiting for live workspace reconciliation.');
    }
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}
