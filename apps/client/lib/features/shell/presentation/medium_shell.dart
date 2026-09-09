import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/domain/auth_models.dart';
import '../../fleet/fleet.dart';
import 'shell_chrome.dart';

class MediumShell extends ConsumerWidget {
  const MediumShell({
    super.key,
    required this.user,
    required this.onSignOut,
    this.onOpenPeon,
    this.onOpenSession,
    this.onNewSession,
    this.overseerName,
    this.onBackToConnections,
  });

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
      key: const Key('medium-shell'),
      body: SafeArea(
        child: Row(
          children: [
            ShellConnectionRail(
              key: const Key('medium-navigation-rail'),
              overseerName: overseerName,
              user: user,
              onBackToConnections: onBackToConnections,
              width: 208,
            ),
            const VerticalDivider(width: 1),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  ShellDesktopHeader(overseerName: overseerName),
                  Expanded(
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
