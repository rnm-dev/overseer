import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../features/auth/application/auth_controller.dart';
import '../features/shell/shell.dart';
import 'desktop_fleet_navigation.dart';

/// Surrounds the Windows content navigator, including imperatively pushed pages.
class DesktopNavigationFrame extends ConsumerStatefulWidget {
  const DesktopNavigationFrame({
    super.key,
    required this.child,
    required this.navigatorKey,
    required this.onOverview,
    required this.onSettings,
    required this.overviewSelected,
    this.selectedChat,
    this.overseerName,
    this.onBackToConnections,
  });

  final Widget child;
  final GlobalKey<NavigatorState> navigatorKey;
  final VoidCallback onOverview;
  final VoidCallback onSettings;
  final bool overviewSelected;
  final SidebarChatIdentity? selectedChat;
  final String? overseerName;
  final VoidCallback? onBackToConnections;

  @override
  ConsumerState<DesktopNavigationFrame> createState() =>
      _DesktopNavigationFrameState();
}

class _DesktopNavigationFrameState
    extends ConsumerState<DesktopNavigationFrame> {
  double? _sidebarWidth;

  @override
  Widget build(BuildContext context) {
    final user = ref.watch(authControllerProvider).session?.user;
    if (user == null) return widget.child;
    return ProviderScope(
      overrides: [
        selectedSidebarChatProvider.overrideWithValue(widget.selectedChat),
        externalShellRailProvider.overrideWithValue(true),
        fleetSidebarBuilderProvider.overrideWithValue(
          (context) => buildDesktopFleetSidebar(
            context,
            navigatorKey: widget.navigatorKey,
          ),
        ),
      ],
      child: LayoutBuilder(
        builder: (context, constraints) {
          // Use the drawer when a usable 208px rail would exceed the 25% cap.
          final compact = constraints.maxWidth < 832;
          final maxSidebarWidth = constraints.maxWidth * .25;
          final sidebarWidth =
              (_sidebarWidth ?? (constraints.maxWidth < 1024 ? 208.0 : 232.0))
                  .clamp(
                    208.0,
                    maxSidebarWidth < 208 ? 208.0 : maxSidebarWidth,
                  );
          Widget rail({VoidCallback? closeDrawer}) => ShellConnectionRail(
            key: const Key('persistent-desktop-sidebar'),
            width: compact ? double.infinity : sidebarWidth,
            user: user,
            overseerName: widget.overseerName,
            onBackToConnections: widget.onBackToConnections,
            overviewSelected: widget.overviewSelected,
            onOverview: () {
              closeDrawer?.call();
              widget.onOverview();
            },
            onSettings: () {
              closeDrawer?.call();
              widget.onSettings();
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
                        Expanded(child: widget.child),
                      ],
                    )
                  : Stack(
                      children: [
                        Row(
                          children: [
                            rail(),
                            const VerticalDivider(width: 1),
                            Expanded(child: widget.child),
                          ],
                        ),
                        Positioned(
                          left: sidebarWidth - 4,
                          top: 0,
                          bottom: 0,
                          width: 9,
                          child: MouseRegion(
                            cursor: SystemMouseCursors.resizeColumn,
                            child: GestureDetector(
                              key: const Key('desktop-sidebar-resizer'),
                              behavior: HitTestBehavior.opaque,
                              onHorizontalDragUpdate: (details) => setState(() {
                                _sidebarWidth =
                                    (sidebarWidth + details.delta.dx).clamp(
                                      208.0,
                                      maxSidebarWidth,
                                    );
                              }),
                              onDoubleTap: () =>
                                  setState(() => _sidebarWidth = null),
                              child: const SizedBox.expand(),
                            ),
                          ),
                        ),
                      ],
                    ),
            ),
          );
        },
      ),
    );
  }
}
