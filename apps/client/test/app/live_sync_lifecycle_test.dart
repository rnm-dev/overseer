import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/app/live_sync_lifecycle.dart';
import 'package:overseer_mobile/features/fleet/application/fleet_controller.dart';

import '../support/fake_fleet.dart';

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

class _RecordingLiveService extends NoopFleetLiveService {
  int resumeCount = 0;
  bool foreground = true;

  @override
  void setForeground(bool value) => foreground = value;

  @override
  Future<void> resumeFromBackground() async {
    resumeCount += 1;
  }
}
