import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/diagnostics/app_diagnostics.dart';
import '../features/fleet/application/fleet_controller.dart';
import '../features/fleet/application/fleet_live_service.dart';

class LiveSyncLifecycle extends ConsumerStatefulWidget {
  const LiveSyncLifecycle({super.key, required this.child});

  final Widget child;

  @override
  ConsumerState<LiveSyncLifecycle> createState() => _LiveSyncLifecycleState();
}

class _LiveSyncLifecycleState extends ConsumerState<LiveSyncLifecycle>
    with WidgetsBindingObserver {
  bool _backgrounded = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    ref
        .read(appDiagnosticsProvider)
        .record(
          AppDiagnosticEvent(
            name: 'app.lifecycle',
            state: state.name,
            outcome: _backgrounded ? 'backgrounded' : 'foreground',
          ),
        );
    if (state == AppLifecycleState.resumed) {
      if (!_backgrounded) return;
      _backgrounded = false;
      final live = ref.read(fleetLiveServiceProvider);
      if (live case final FleetLiveLifecycle lifecycle) {
        ref
            .read(appDiagnosticsProvider)
            .record(
              const AppDiagnosticEvent(
                name: 'live.lifecycle',
                state: 'resumed',
                outcome: 'reconnecting',
              ),
            );
        unawaited(lifecycle.resumeFromBackground());
      }
      return;
    }
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden) {
      _backgrounded = true;
    }
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
