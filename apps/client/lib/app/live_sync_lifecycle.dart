import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/diagnostics/app_diagnostics.dart';
import '../features/fleet/application/fleet_controller.dart';

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
    ref.listenManual(fleetLiveServiceProvider, (_, live) {
      final state = WidgetsBinding.instance.lifecycleState;
      live?.setForeground(state == null || state == AppLifecycleState.resumed);
    }, fireImmediately: true);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final live = ref.read(fleetLiveServiceProvider);
    live?.setForeground(state == AppLifecycleState.resumed);
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
      if (live != null) {
        ref
            .read(appDiagnosticsProvider)
            .record(
              const AppDiagnosticEvent(
                name: 'live.lifecycle',
                state: 'resumed',
                outcome: 'reconnecting',
              ),
            );
        unawaited(live.resumeFromBackground());
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
