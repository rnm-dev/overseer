import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/domain/auth_models.dart';
import '../../fleet/fleet.dart';
import 'shell_chrome.dart';

/// Medium and wide layouts: a connection rail beside the fleet overview.
class RailShell extends ConsumerWidget {
  const RailShell({
    super.key,
    required this.wide,
    required this.user,
    required this.onSignOut,
    this.onOpenPeon,
    this.onOpenSession,
    this.onNewSession,
    this.overseerName,
    this.onBackToConnections,
  });

  final bool wide;
  final OperatorIdentity? user;
  final Future<void> Function()? onSignOut;
  final void Function(
    BuildContext context, {
    required String workspaceId,
    required String peonId,
  })?
  onOpenPeon;
  final FleetOpenSession? onOpenSession;
  final FleetNewSession? onNewSession;
  final String? overseerName;
  final VoidCallback? onBackToConnections;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      key: Key(wide ? 'wide-shell' : 'medium-shell'),
      body: SafeArea(
        child: Row(
          children: [
            ShellConnectionRail(
              key: Key(wide ? 'wide-sidebar' : 'medium-navigation-rail'),
              width: wide ? 232 : 208,
              overseerName: overseerName,
              user: user,
              onBackToConnections: onBackToConnections,
            ),
            const VerticalDivider(width: 1),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  ShellDesktopHeader(overseerName: overseerName),
                  if (wide) const Divider(height: 1),
                  Expanded(
                    key: wide ? const Key('wide-master-pane') : null,
                    child: ColoredBox(
                      color: Theme.of(context).colorScheme.surface,
                      child: user == null
                          ? const FleetOverviewLoading()
                          : Center(
                              child: ConstrainedBox(
                                constraints: BoxConstraints(
                                  maxWidth: ref.watch(
                                    fleetOverviewMaxWidthProvider,
                                  ),
                                ),
                                child: FleetOverview(
                                  user: user!,
                                  onSignOut: onSignOut!,
                                  onOpenPeon: onOpenPeon,
                                  onOpenSession: onOpenSession,
                                  onNewSession: onNewSession,
                                ),
                              ),
                            ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
