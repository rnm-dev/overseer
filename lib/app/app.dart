import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:overseer_mobile/core/notifications/notification_routing.dart';
import 'package:overseer_mobile/features/auth/presentation/auth_gate.dart';
import 'package:overseer_mobile/shared/design/theme.dart';

import 'peon_deep_link_page.dart';
import 'project_files_route_page.dart';
import 'session_deep_link_page.dart';

class OverseerMobileApp extends StatefulWidget {
  const OverseerMobileApp({
    super.key,
    this.navigationDestination,
    this.navigationRevision = 0,
    this.foregroundNotification,
    this.onOpenNotification,
    this.onDismissNotification,
  });

  final NotificationDestination? navigationDestination;
  final int navigationRevision;
  final InAppNotification? foregroundNotification;
  final ValueChanged<NotificationDestination>? onOpenNotification;
  final VoidCallback? onDismissNotification;

  @override
  State<OverseerMobileApp> createState() => _OverseerMobileAppState();
}

class _OverseerMobileAppState extends State<OverseerMobileApp> {
  late final GoRouter _router = GoRouter(
    initialLocation: widget.navigationDestination?.location ?? '/',
    routes: [
      GoRoute(
        path: '/',
        name: 'home',
        builder: (context, state) => const AuthGate(),
      ),
      GoRoute(
        path: '/peon',
        name: 'peon',
        builder: (context, state) {
          final workspaceId = state.uri.queryParameters['workspaceId'];
          final peonId = state.uri.queryParameters['peonId'];
          if (workspaceId == null || peonId == null) {
            return const AuthGate();
          }
          return PeonDeepLinkPage(
            key: ValueKey('$workspaceId\u0000$peonId'),
            workspaceId: workspaceId,
            peonId: peonId,
          );
        },
      ),
      GoRoute(
        path: '/session',
        name: 'session',
        builder: (context, state) {
          final workspaceId = state.uri.queryParameters['workspaceId'];
          final peonId = state.uri.queryParameters['peonId'];
          final sessionId = state.uri.queryParameters['sessionId'];
          if (workspaceId == null || peonId == null || sessionId == null) {
            return const AuthGate();
          }
          return SessionDeepLinkPage(
            key: ValueKey('$workspaceId\u0000$peonId\u0000$sessionId'),
            workspaceId: workspaceId,
            peonId: peonId,
            sessionId: sessionId,
          );
        },
      ),
      GoRoute(
        path: '/project-files',
        name: 'project-files',
        builder: (context, state) {
          final workspaceId = state.uri.queryParameters['workspaceId'];
          final peonId = state.uri.queryParameters['peonId'];
          if (workspaceId == null || peonId == null) {
            return const AuthGate();
          }
          return ProjectFilesRoutePage(
            key: ValueKey('$workspaceId\u0000$peonId'),
            workspaceId: workspaceId,
            peonId: peonId,
            projectKey: state.uri.queryParameters['projectKey'],
            projectId: state.uri.queryParameters['projectId'],
          );
        },
      ),
    ],
  );

  @override
  void didUpdateWidget(covariant OverseerMobileApp oldWidget) {
    super.didUpdateWidget(oldWidget);
    final destination = widget.navigationDestination;
    if (destination != null &&
        widget.navigationRevision != oldWidget.navigationRevision) {
      _router.go(destination.location);
    }
  }

  @override
  void dispose() {
    _router.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'Overseer Mobile',
      theme: AppTheme.dark,
      routerConfig: _router,
      builder: (context, child) => ForegroundNotificationSurface(
        notification: widget.foregroundNotification,
        onOpen: widget.onOpenNotification,
        onDismiss: widget.onDismissNotification,
        child: child ?? const SizedBox.shrink(),
      ),
    );
  }
}

class ForegroundNotificationSurface extends StatelessWidget {
  const ForegroundNotificationSurface({
    super.key,
    required this.notification,
    required this.child,
    this.onOpen,
    this.onDismiss,
  });

  final InAppNotification? notification;
  final Widget child;
  final ValueChanged<NotificationDestination>? onOpen;
  final VoidCallback? onDismiss;

  @override
  Widget build(BuildContext context) {
    final current = notification;
    return Stack(
      children: [
        child,
        if (current != null)
          SafeArea(
            child: Align(
              alignment: Alignment.topCenter,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                child: Material(
                  key: const Key('foreground-notification'),
                  color: const Color(0xFF202523),
                  elevation: 12,
                  shadowColor: Colors.black54,
                  borderRadius: BorderRadius.circular(14),
                  clipBehavior: Clip.antiAlias,
                  child: InkWell(
                    onTap: () => onOpen?.call(current.destination),
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 560),
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(14, 11, 6, 11),
                        child: Row(
                          children: [
                            const Icon(
                              Icons.notifications_active_outlined,
                              color: Color(0xFF52F0B0),
                              size: 22,
                            ),
                            const SizedBox(width: 11),
                            Expanded(
                              child: Column(
                                mainAxisSize: MainAxisSize.min,
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    current.title,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                      color: Color(0xFFF4F1E8),
                                      fontWeight: FontWeight.w600,
                                      fontSize: 14,
                                    ),
                                  ),
                                  const SizedBox(height: 2),
                                  Text(
                                    current.body,
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                      color: Color(0xFFB8BBB5),
                                      fontSize: 12,
                                      height: 1.25,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            Semantics(
                              button: true,
                              label: 'Dismiss notification',
                              child: IconButton(
                                key: const Key(
                                  'dismiss-foreground-notification',
                                ),
                                onPressed: onDismiss,
                                icon: const Icon(
                                  Icons.close,
                                  size: 18,
                                  color: Color(0xFFB8BBB5),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}
