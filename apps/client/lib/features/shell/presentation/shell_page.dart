import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'shell_chrome.dart';

import '../../auth/domain/auth_models.dart';
import '../../fleet/fleet.dart';
import '../../../shared/layout/responsive_breakpoints.dart';
import 'compact_shell.dart';
import 'medium_shell.dart';
import 'wide_shell.dart';

/// Set by the persistent desktop frame to avoid nesting a second sidebar.
final externalShellRailProvider = Provider<bool>((ref) => false);

class ShellPage extends ConsumerWidget {
  const ShellPage({
    super.key,
    required this.user,
    required this.onSignOut,
    this.onOpenPeon,
    this.onOpenSession,
    this.onNewSession,
    this.overseerName,
    this.onBackToConnections,
  }) : assert(user != null),
       assert(onSignOut != null);

  const ShellPage.loading({
    super.key,
    this.overseerName,
    this.onBackToConnections,
  }) : user = null,
       onSignOut = null,
       onOpenPeon = null,
       onOpenSession = null,
       onNewSession = null;

  final OperatorIdentity? user;
  final Future<void> Function()? onSignOut;
  final void Function(
    BuildContext context, {
    required String workspaceId,
    required String peonId,
  })?
  onOpenPeon;
  final void Function(
    BuildContext context, {
    required String workspaceId,
    required String peonId,
    required String sessionId,
  })?
  onOpenSession;
  final FleetNewSession? onNewSession;
  final String? overseerName;
  final VoidCallback? onBackToConnections;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (ref.watch(externalShellRailProvider)) {
      return Scaffold(
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ShellDesktopHeader(overseerName: overseerName),
            const Divider(height: 1),
            Expanded(
              child: user == null
                  ? const FleetOverviewLoading()
                  : FleetOverview(
                      user: user!,
                      onSignOut: onSignOut!,
                      onOpenPeon: onOpenPeon,
                      onOpenSession: onOpenSession,
                      onNewSession: onNewSession,
                    ),
            ),
          ],
        ),
      );
    }
    return LayoutBuilder(
      builder: (context, constraints) {
        return switch (ResponsiveBreakpoints.sizeFor(constraints.maxWidth)) {
          ResponsiveLayoutSize.compact => CompactShell(
            user: user,
            onSignOut: onSignOut,
            onOpenPeon: onOpenPeon,
            onOpenSession: onOpenSession,
            onNewSession: onNewSession,
            overseerName: overseerName,
            onBackToConnections: onBackToConnections,
          ),
          ResponsiveLayoutSize.medium => MediumShell(
            user: user,
            onSignOut: onSignOut,
            onOpenPeon: onOpenPeon,
            onOpenSession: onOpenSession,
            onNewSession: onNewSession,
            overseerName: overseerName,
            onBackToConnections: onBackToConnections,
          ),
          ResponsiveLayoutSize.wide => WideShell(
            user: user,
            onSignOut: onSignOut,
            onOpenPeon: onOpenPeon,
            onOpenSession: onOpenSession,
            onNewSession: onNewSession,
            overseerName: overseerName,
            onBackToConnections: onBackToConnections,
          ),
        };
      },
    );
  }
}
