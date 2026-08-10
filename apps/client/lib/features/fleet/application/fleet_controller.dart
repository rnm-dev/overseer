import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/diagnostics/app_diagnostics.dart';
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
final attentionProjectionSinkProvider = Provider<AttentionProjectionSink?>(
  (ref) => null,
);
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
  FleetLiveService? _live;
  LiveProjectionSink? _liveSink;
  Future<void> _liveReconciliation = Future<void>.value();

  @override
  Future<List<WorkspaceFleet>> build() async {
    final repository = ref.read(fleetRepositoryProvider);
    final fleet = repository is CachedFleetRepository
        ? await _loadCachedFirst(repository)
        : await repository.loadFleet();
    unawaited(
      ref
          .read(workspaceConnectionRecorderProvider)
          .recordWorkspaceIds(fleet.map((item) => item.workspace.id))
          .catchError((error) {
            ref
                .read(appDiagnosticsProvider)
                .record(
                  AppDiagnosticEvent(
                    name: 'workspace.connection_record',
                    level: AppDiagnosticLevel.warning,
                    state: 'failed',
                    errorType: error.runtimeType.toString(),
                  ),
                );
          }),
    );
    final live = ref.read(fleetLiveServiceProvider);
    if (live != null) {
      final sink = ref.read(liveProjectionSinkProvider);
      final attentionSink = ref.read(attentionProjectionSinkProvider);
      _live = live;
      _liveSink = sink;
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
      final attentionLive = live is AttentionFleetLiveService
          ? live as AttentionFleetLiveService
          : null;
      if (attentionLive != null) {
        attentionLive.setAttentionHandler((
          workspaceId,
          cursor,
          attention,
        ) async {
          if (attentionSink == null) {
            await sink?.advanceCursor(workspaceId: workspaceId, cursor: cursor);
            return;
          }
          await attentionSink.applyAttentionProjection(
            workspaceId: workspaceId,
            cursor: cursor,
            projection: attention,
          );
        });
      }
      unawaited(
        live.connect(
          workspaceIds: workspaceIds,
          initialCursors: cursors,
          onPeon: _applyPeon,
          onSession: (workspaceId, cursor, session) async {
            if (sink == null) return false;
            await sink.applyLiveProjection(
              workspaceId: workspaceId,
              cursor: cursor,
              projection: session,
            );
            return true;
          },
          onProject: (workspaceId, cursor, project) async {
            if (projectSink == null) return false;
            await projectSink.applyLiveProjection(
              workspaceId: workspaceId,
              cursor: cursor,
              projection: project,
            );
            return true;
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

  Future<List<WorkspaceFleet>> _loadCachedFirst(
    CachedFleetRepository repository,
  ) async {
    final cached = await repository.loadCachedFleet();
    final subscription = repository.watchFleet().listen((fleet) {
      state = AsyncData(fleet);
      _scheduleWorkspaceReconciliation(fleet);
    });
    ref.onDispose(() => unawaited(subscription.cancel()));
    if (cached.isEmpty) return repository.refreshFleet();
    unawaited(
      repository.refreshFleet().catchError((error) {
        ref
            .read(appDiagnosticsProvider)
            .record(
              AppDiagnosticEvent(
                name: 'workspace.refresh',
                level: AppDiagnosticLevel.warning,
                state: 'failed',
                outcome: 'cached',
                errorType: error.runtimeType.toString(),
              ),
            );
        return cached;
      }),
    );
    return cached;
  }

  void _scheduleWorkspaceReconciliation(List<WorkspaceFleet> fleet) {
    final live = _live;
    final FleetWorkspaceReconciler? reconciler =
        live is FleetWorkspaceReconciler
        ? live as FleetWorkspaceReconciler
        : null;
    if (reconciler == null) return;
    final workspaceIds = fleet.map((item) => item.workspace.id).toList();
    final diagnostics = ref.read(appDiagnosticsProvider);
    diagnostics.record(
      const AppDiagnosticEvent(name: 'workspace.reconcile', state: 'scheduled'),
    );
    _liveReconciliation = _liveReconciliation
        .then((_) async {
          final sink = _liveSink;
          final cursors = sink == null
              ? const <String, int>{}
              : {
                  for (final workspaceId in workspaceIds)
                    workspaceId: await sink.cursorFor(workspaceId),
                };
          await reconciler.reconcileWorkspaces(
            workspaceIds: workspaceIds,
            initialCursors: cursors,
          );
          diagnostics.record(
            const AppDiagnosticEvent(
              name: 'workspace.reconcile',
              state: 'complete',
            ),
          );
        })
        .catchError((error) {
          diagnostics.record(
            AppDiagnosticEvent(
              name: 'workspace.reconcile',
              level: AppDiagnosticLevel.warning,
              state: 'failed',
              errorType: error.runtimeType.toString(),
            ),
          );
        });
  }

  Future<void> refresh() async {
    final repository = ref.read(fleetRepositoryProvider);
    state = await AsyncValue.guard(
      repository is CachedFleetRepository
          ? repository.refreshFleet
          : repository.loadFleet,
    );
  }

  Future<bool> _applyPeon(
    String workspaceId,
    int cursor,
    Map<String, dynamic> projection,
  ) async {
    final repository = ref.read(fleetRepositoryProvider);
    var durable = false;
    if (repository is CachedFleetRepository) {
      await repository.applyPeonProjection(
        workspaceId: workspaceId,
        cursor: cursor,
        projection: projection,
      );
      durable = true;
    }
    final current = state.value;
    final peonId = projection['peonId'];
    if (current == null || peonId is! String) return durable;

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
                    recentSessions: peon.recentSessions,
                  ),
            ],
          ),
    ]);
    return durable;
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
                    recentSessions: peon.recentSessions,
                  ),
            ],
          ),
    ]);
  }
}
