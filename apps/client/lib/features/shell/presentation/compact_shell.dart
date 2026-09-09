import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'shell_chrome.dart';

import '../../../shared/design/typography.dart';
import '../../../shared/widgets/app_navigation_bar.dart';
import '../../auth/domain/auth_models.dart';
import '../../fleet/fleet.dart';

class CompactShell extends ConsumerWidget {
  const CompactShell({
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
    final hasSidebar =
        user != null && ref.watch(fleetSidebarBuilderProvider) != null;
    return Scaffold(
      key: const Key('compact-shell'),
      drawer: hasSidebar
          ? Drawer(
              child: ShellConnectionRail(
                overseerName: overseerName,
                user: user,
                onBackToConnections: onBackToConnections,
                width: double.infinity,
              ),
            )
          : null,
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            AppNavigationBar(
              key: const Key('overseer-index-navbar'),
              showBackButton: onBackToConnections != null,
              onBack: onBackToConnections,
              backButtonKey: const Key('back-to-overseer-list'),
              backTooltip: 'Back to Overseer list',
              right: hasSidebar
                  ? Builder(
                      builder: (context) => IconButton(
                        tooltip: 'Projects and chats',
                        icon: const Icon(LucideIcons.panelLeft, size: 20),
                        onPressed: () => Scaffold.of(context).openDrawer(),
                      ),
                    )
                  : null,
              left: Text(
                overseerName ?? 'Overseer',
                key: const Key('current-overseer-name'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppTypography.controlLabel(),
              ),
            ),
            Expanded(
              child: user == null
                  ? const FleetOverviewLoading(compact: true)
                  : FleetOverview(
                      compact: true,
                      user: user!,
                      onSignOut: onSignOut!,
                      onOpenPeon: onOpenPeon,
                      onOpenSession: onOpenSession,
                      onNewSession: onNewSession,
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
