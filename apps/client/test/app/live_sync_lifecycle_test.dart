import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/app/live_sync_lifecycle.dart';
import 'package:overseer_mobile/core/live/active_sessions.dart';
import 'package:overseer_mobile/core/live/presence.dart';
import 'package:overseer_mobile/features/fleet/application/fleet_controller.dart';
import 'package:overseer_mobile/features/fleet/application/fleet_live_service.dart';

void main() {
  testWidgets(
    'restarts live sync immediately after returning from background',
    (tester) async {
      final live = _RecordingLiveService();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [fleetLiveServiceProvider.overrideWithValue(live)],
          child: const LiveSyncLifecycle(child: SizedBox()),
        ),
      );

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(live.resumeCount, 0);
      expect(live.foreground, isTrue);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pump();
      expect(live.foreground, isFalse);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(live.resumeCount, 1);
      expect(live.foreground, isTrue);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(live.resumeCount, 1);
    },
  );
}

class _RecordingLiveService
    implements FleetLiveService, FleetLiveLifecycle, FleetLiveForeground {
  int resumeCount = 0;
  bool foreground = true;

  @override
  void setForeground(bool value) => foreground = value;

  @override
  Future<void> connect({
    required List<String> workspaceIds,
    required Map<String, int> initialCursors,
    required Future<bool> Function(String, int, Map<String, dynamic>) onPeon,
    required Future<bool> Function(String, int, Map<String, dynamic>) onSession,
    required Future<bool> Function(String, int, Map<String, dynamic>) onProject,
    required Future<void> Function(String, int) onCursor,
    required void Function(String, String, int) onActiveSessions,
    required void Function(String, List<ActiveSession>?)
    onActiveSessionSnapshot,
    required void Function(String, List<PresenceEntry>) onPresence,
  }) async {}

  @override
  Future<void> resumeFromBackground() async {
    resumeCount += 1;
  }

  @override
  void setPresence({
    required String workspaceId,
    required PresenceLocation location,
  }) {}

  @override
  Future<void> stop() async {}
}
