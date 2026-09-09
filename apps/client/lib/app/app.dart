import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:overseer_mobile/l10n/l10n.dart';
import 'package:go_router/go_router.dart';
import 'package:overseer_mobile/core/notifications/notification_routing.dart';
import 'package:overseer_mobile/features/auth/presentation/auth_gate.dart';
import 'package:overseer_mobile/features/auth/presentation/sign_in_page.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';
import 'package:overseer_mobile/shared/design/theme.dart';
import 'package:overseer_mobile/features/shell/shell.dart';
import 'package:overseer_mobile/features/sessions/presentation/session_detail_page.dart';
import 'package:overseer_mobile/features/themes/application/connection_theme_controller.dart';

import 'peon_deep_link_page.dart';
import 'project_files_route_page.dart';
import 'project_detail_route_page.dart';
import 'session_deep_link_page.dart';
import 'desktop_navigation_frame.dart';

class OverseerMobileApp extends ConsumerStatefulWidget {
  const OverseerMobileApp({
    super.key,
    this.navigationDestination,
    this.navigationRevision = 0,
    this.foregroundNotification,
    this.onOpenNotification,
    this.onDismissNotification,
    this.autoSignIn = false,
    this.onBackToConnections,
    this.overseerName,
  });

  final NotificationDestination? navigationDestination;
  final int navigationRevision;
  final InAppNotification? foregroundNotification;
  final ValueChanged<NotificationDestination>? onOpenNotification;
  final VoidCallback? onDismissNotification;
  final bool autoSignIn;
  final VoidCallback? onBackToConnections;
  final String? overseerName;

  @override
  ConsumerState<OverseerMobileApp> createState() => _OverseerMobileAppState();
}

class _OverseerMobileAppState extends ConsumerState<OverseerMobileApp> {
  final _contentNavigatorKey = GlobalKey<NavigatorState>();
  late final GoRouter _router = GoRouter(
    initialLocation: widget.navigationDestination?.location ?? '/',
    routes: ref.read(fleetSidebarBuilderProvider) == null
        ? _routes
        : [
            ShellRoute(
              navigatorKey: _contentNavigatorKey,
              builder: (context, state, child) => DesktopNavigationFrame(
                navigatorKey: _contentNavigatorKey,
                overviewSelected: state.uri.path == '/',
                onOverview: () {
                  _contentNavigatorKey.currentState?.popUntil(
                    (route) => route.isFirst,
                  );
                  _router.goNamed('home');
                },
                overseerName: widget.overseerName,
                onBackToConnections: widget.onBackToConnections,
                child: child,
              ),
              routes: _routes,
            ),
          ],
  );

  List<RouteBase> get _routes => [
    GoRoute(
      path: '/',
      name: 'home',
      builder: (context, state) => AuthGate(
        autoSignIn: widget.autoSignIn,
        onBack: widget.onBackToConnections,
        overseerName: widget.overseerName,
        buildLoading: _buildAuthLoading,
        buildSignIn: _buildAuthSignIn,
        buildShell: _buildAuthShell,
      ),
      routes: [
        GoRoute(
          path: 'session',
          name: 'session',
          builder: (context, state) {
            final workspaceId = state.uri.queryParameters['workspaceId'];
            final peonId = state.uri.queryParameters['peonId'];
            final sessionId = state.uri.queryParameters['sessionId'];
            if (workspaceId == null || peonId == null || sessionId == null) {
              return AuthGate(
                autoSignIn: widget.autoSignIn,
                onBack: widget.onBackToConnections,
                overseerName: widget.overseerName,
                buildLoading: _buildAuthLoading,
                buildSignIn: _buildAuthSignIn,
                buildShell: _buildAuthShell,
              );
            }
            return SessionDeepLinkPage(
              key: ValueKey('$workspaceId\u0000$peonId\u0000$sessionId'),
              workspaceId: workspaceId,
              peonId: peonId,
              sessionId: sessionId,
            );
          },
        ),
      ],
    ),
    GoRoute(
      path: '/peon',
      name: 'peon',
      builder: (context, state) {
        final workspaceId = state.uri.queryParameters['workspaceId'];
        final peonId = state.uri.queryParameters['peonId'];
        if (workspaceId == null || peonId == null) {
          return AuthGate(
            autoSignIn: widget.autoSignIn,
            onBack: widget.onBackToConnections,
            overseerName: widget.overseerName,
            buildLoading: _buildAuthLoading,
            buildSignIn: _buildAuthSignIn,
            buildShell: _buildAuthShell,
          );
        }
        return PeonDeepLinkPage(
          key: ValueKey('$workspaceId\u0000$peonId'),
          workspaceId: workspaceId,
          peonId: peonId,
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
          return AuthGate(
            autoSignIn: widget.autoSignIn,
            onBack: widget.onBackToConnections,
            overseerName: widget.overseerName,
            buildLoading: _buildAuthLoading,
            buildSignIn: _buildAuthSignIn,
            buildShell: _buildAuthShell,
          );
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
    GoRoute(
      path: '/project',
      name: 'project',
      builder: (context, state) {
        final workspaceId = state.uri.queryParameters['workspaceId'];
        final peonId = state.uri.queryParameters['peonId'];
        final projectId = state.uri.queryParameters['projectId'];
        final projectKey = state.uri.queryParameters['projectKey'];
        if (workspaceId == null ||
            peonId == null ||
            projectId == null ||
            projectKey == null) {
          return AuthGate(
            autoSignIn: widget.autoSignIn,
            onBack: widget.onBackToConnections,
            overseerName: widget.overseerName,
            buildLoading: _buildAuthLoading,
            buildSignIn: _buildAuthSignIn,
            buildShell: _buildAuthShell,
          );
        }
        return ProjectDetailRoutePage(
          key: ValueKey(
            '$workspaceId\u0000$peonId\u0000$projectId\u0000$projectKey',
          ),
          workspaceId: workspaceId,
          peonId: peonId,
          projectId: projectId,
          projectKey: projectKey,
          projectName: state.uri.queryParameters['projectName'],
          projectSyncedAt: state.uri.queryParameters['syncedAt'],
          isOwner: state.uri.queryParameters['isOwner'] == 'true',
        );
      },
    ),
  ];

  Widget _buildAuthLoading({
    required String? overseerName,
    required VoidCallback? onBackToConnections,
  }) => ShellPage.loading(
    overseerName: overseerName,
    onBackToConnections: onBackToConnections,
  );

  Widget _buildAuthSignIn({
    required Future<void> Function() onSignIn,
    String? errorMessage,
    required bool isSigningIn,
    VoidCallback? onBack,
  }) => SignInPage(
    onSignIn: onSignIn,
    errorMessage: errorMessage,
    isSigningIn: isSigningIn,
    onBack: onBack,
  );

  Widget _buildAuthShell({
    required OperatorIdentity user,
    required Future<void> Function() onSignOut,
    String? overseerName,
    VoidCallback? onBackToConnections,
  }) => ShellPage(
    user: user,
    onSignOut: onSignOut,
    overseerName: overseerName,
    onBackToConnections: onBackToConnections,
    onOpenPeon:
        (context, {required String workspaceId, required String peonId}) =>
            context.pushNamed(
              'peon',
              queryParameters: {'workspaceId': workspaceId, 'peonId': peonId},
            ),
    onOpenSession:
        (
          context, {
          required String workspaceId,
          required String peonId,
          required String sessionId,
        }) => context.pushNamed(
          'session',
          queryParameters: {
            'workspaceId': workspaceId,
            'peonId': peonId,
            'sessionId': sessionId,
          },
        ),
    onNewSession:
        (context, {required String workspaceId, required String peonId}) =>
            Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => SessionDetailPage.newSession(
                  workspaceId: workspaceId,
                  peonId: peonId,
                ),
              ),
            ),
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
    return Consumer(
      builder: (context, ref, _) {
        final controller = ref.watch(connectionThemeControllerProvider);
        return ListenableBuilder(
          listenable: controller,
          builder: (context, _) => MaterialApp.router(
            onGenerateTitle: (context) => context.l10n.appTitle,
            localizationsDelegates: const [
              AppLocalizations.delegate,
              GlobalMaterialLocalizations.delegate,
              GlobalWidgetsLocalizations.delegate,
              GlobalCupertinoLocalizations.delegate,
            ],
            supportedLocales: AppLocalizations.supportedLocales,
            theme: AppTheme.fromPackage(controller.theme),
            routerConfig: _router,
            builder: (context, child) => ForegroundNotificationSurface(
              notification: widget.foregroundNotification,
              onOpen: widget.onOpenNotification,
              onDismiss: widget.onDismissNotification,
              child: child ?? const SizedBox.shrink(),
            ),
          ),
        );
      },
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
    final colors = Theme.of(context).colorScheme;
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
                  color: colors.surfaceContainerHighest,
                  elevation: 12,
                  shadowColor: colors.shadow.withValues(alpha: 0.54),
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
                            Icon(
                              Icons.notifications_active_outlined,
                              color: colors.primary,
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
                                    style: TextStyle(
                                      color: colors.onSurface,
                                      fontWeight: FontWeight.w600,
                                      fontSize: 14,
                                    ),
                                  ),
                                  const SizedBox(height: 2),
                                  Text(
                                    current.body,
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      color: colors.onSurfaceVariant,
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
                                icon: Icon(
                                  Icons.close,
                                  size: 18,
                                  color: colors.onSurfaceVariant,
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
