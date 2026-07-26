import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

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
    if (state == AppLifecycleState.resumed) {
      if (!_backgrounded) return;
      _backgrounded = false;
      final live = ref.read(fleetLiveServiceProvider);
      if (live case final FleetLiveLifecycle lifecycle) {
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
