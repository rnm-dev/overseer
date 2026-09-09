import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../features/auth/application/auth_controller.dart';
import '../features/shell/shell.dart';
import 'desktop_fleet_navigation.dart';

/// Surrounds the Windows content navigator, including imperatively pushed pages.
class DesktopNavigationFrame extends ConsumerWidget {
  const DesktopNavigationFrame({
    super.key,
    required this.child,
    required this.navigatorKey,
    required this.onOverview,
    required this.overviewSelected,
    this.overseerName,
    this.onBackToConnections,
  });

  final Widget child;
  final GlobalKey<NavigatorState> navigatorKey;
  final VoidCallback onOverview;
  final bool overviewSelected;
  final String? overseerName;
  final VoidCallback? onBackToConnections;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(authControllerProvider).session?.user;
    if (user == null) return child;
    return ProviderScope(
      overrides: [
        externalShellRailProvider.overrideWithValue(true),
        fleetSidebarBuilderProvider.overrideWithValue(
          (context) =>
              buildDesktopFleetSidebar(context, navigatorKey: navigatorKey),
        ),
      ],
      child: LayoutBuilder(
        builder: (context, constraints) {
          final compact = constraints.maxWidth < 600;
          Widget rail({VoidCallback? closeDrawer}) => ShellConnectionRail(
            key: const Key('persistent-desktop-sidebar'),
            width: compact
                ? double.infinity
                : constraints.maxWidth < 1024
                ? 208
                : 232,
            user: user,
            overseerName: overseerName,
            onBackToConnections: onBackToConnections,
            overviewSelected: overviewSelected,
            onOverview: () {
              closeDrawer?.call();
              onOverview();
            },
          );
          return Scaffold(
            drawer: compact
                ? Builder(
                    builder: (context) => Drawer(
                      child: rail(
                        closeDrawer: () => Scaffold.of(context).closeDrawer(),
                      ),
                    ),
                  )
                : null,
            body: SafeArea(
              child: compact
                  ? Column(
                      children: [
                        Align(
                          alignment: Alignment.centerLeft,
                          child: Builder(
                            builder: (context) => IconButton(
                              tooltip: 'Projects and chats',
                              icon: const Icon(LucideIcons.panelLeft),
                              onPressed: () =>
                                  Scaffold.of(context).openDrawer(),
                            ),
                          ),
                        ),
                        Expanded(child: child),
                      ],
                    )
                  : Row(
                      children: [
                        rail(),
                        const VerticalDivider(width: 1),
                        Expanded(child: child),
                      ],
                    ),
            ),
          );
        },
      ),
    );
  }
}
