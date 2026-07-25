import 'dart:async';

import 'package:flutter/material.dart';
import 'package:overseer_mobile/app/app.dart';
import 'package:overseer_mobile/app/app_dependencies.dart';
import 'package:overseer_mobile/core/config/app_config.dart';
import 'package:overseer_mobile/core/config/overseer_connection_store.dart';
import 'package:overseer_mobile/core/notifications/notification_routing.dart';
import 'package:overseer_mobile/features/auth/presentation/auth_restoring_page.dart';
import 'package:overseer_mobile/features/auth/presentation/overseer_connections_page.dart';
import 'package:overseer_mobile/features/auth/presentation/server_setup_page.dart';
import 'package:overseer_mobile/shared/design/theme.dart';

class AppBootstrap extends StatefulWidget {
  const AppBootstrap({
    super.key,
    this.store,
    this.environmentConfig,
    this.notificationGateway = const NoopNotificationMessageGateway(),
    this.notificationRouteStore,
  });

  final OverseerConnectionStore? store;
  final AppConfig? environmentConfig;
  final NotificationMessageGateway notificationGateway;
  final NotificationRouteStore? notificationRouteStore;

  @override
  State<AppBootstrap> createState() => _AppBootstrapState();
}

class _AppBootstrapState extends State<AppBootstrap>
    with WidgetsBindingObserver {
  late final OverseerConnectionStore _store;
  late final AppConfig _environmentConfig;
  late final NotificationRouteStore _notificationRouteStore;
  List<OverseerConnection> _connections = const <OverseerConnection>[];
  OverseerConnection? _selectedConnection;
  NotificationDestination? _navigationDestination;
  int _navigationRevision = 0;
  InAppNotification? _foregroundNotification;
  StreamSubscription<InAppNotification>? _foregroundSubscription;
  StreamSubscription<NotificationDestination>? _openedSubscription;
  Timer? _foregroundTimer;
  bool _loading = true;
  bool _adding = false;

  @override
  void initState() {
    super.initState();
    _store = widget.store ?? SharedPreferencesOverseerConnectionStore();
    _environmentConfig =
        widget.environmentConfig ?? AppConfig.fromEnvironment();
    _notificationRouteStore =
        widget.notificationRouteStore ??
        SharedPreferencesNotificationRouteStore();
    WidgetsBinding.instance.addObserver(this);
    _foregroundSubscription = widget.notificationGateway.foregroundNotifications
        .listen(_showForegroundNotification);
    _openedSubscription = widget.notificationGateway.openedDestinations.listen(
      (destination) => unawaited(_openDestination(destination)),
    );
    _restore();
    _restoreInitialDestination();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _foregroundTimer?.cancel();
    unawaited(_foregroundSubscription?.cancel());
    unawaited(_openedSubscription?.cancel());
    super.dispose();
  }

  @override
  Future<bool> didPushRouteInformation(
    RouteInformation routeInformation,
  ) async {
    final destination = NotificationDestination.fromUri(routeInformation.uri);
    if (destination == null) return false;
    await _openDestination(destination);
    return true;
  }

  Future<void> _restoreInitialDestination() async {
    final platformRoute =
        WidgetsBinding.instance.platformDispatcher.defaultRouteName;
    final platformDestination = NotificationDestination.fromUri(
      Uri.tryParse(platformRoute) ?? Uri(),
    );
    if (platformDestination != null) {
      await _openDestination(platformDestination);
      return;
    }
    try {
      final destination = await widget.notificationGateway.initialDestination();
      if (destination != null) await _openDestination(destination);
    } catch (_) {
      // Notification restoration must never prevent connection selection.
    }
  }

  Future<void> _restore() async {
    List<OverseerConnection> connections;
    try {
      connections = await _store.readAll();
    } catch (_) {
      connections = const <OverseerConnection>[];
    }
    if (!mounted) return;
    setState(() {
      _connections = connections;
      _loading = false;
    });
    final destination = _navigationDestination;
    if (destination != null && _selectedConnection == null) {
      await _openDestination(destination);
    }
  }

  Future<void> _add(Uri serverUrl) async {
    final connections = await _store.add(serverUrl);
    if (!mounted) return;
    setState(() {
      _connections = connections;
      _adding = false;
    });
  }

  void _select(OverseerConnection connection) {
    setState(() {
      _selectedConnection = connection;
    });
  }

  Future<void> _openDestination(NotificationDestination destination) async {
    Uri? mappedServer;
    try {
      mappedServer = await _notificationRouteStore.connectionForWorkspace(
        destination.workspaceId,
      );
    } catch (_) {
      // A stale/corrupt route hint can safely fall back to the current choice.
    }
    if (!mounted) return;
    final mappedConnection = mappedServer == null
        ? null
        : _connections
              .where((item) => item.serverUrl == mappedServer)
              .firstOrNull;
    final connection =
        mappedConnection ??
        _selectedConnection ??
        (_connections.length == 1 ? _connections.single : null);
    setState(() {
      if (connection != null) _selectedConnection = connection;
      _navigationDestination = destination;
      _navigationRevision += 1;
      _foregroundNotification = null;
    });
  }

  void _showForegroundNotification(InAppNotification notification) {
    _foregroundTimer?.cancel();
    if (!mounted) return;
    setState(() => _foregroundNotification = notification);
    _foregroundTimer = Timer(const Duration(seconds: 8), () {
      if (mounted && _foregroundNotification == notification) {
        setState(() => _foregroundNotification = null);
      }
    });
  }

  void _dismissForegroundNotification() {
    _foregroundTimer?.cancel();
    setState(() => _foregroundNotification = null);
  }

  Widget _withForegroundSurface(Widget child) {
    return ForegroundNotificationSurface(
      notification: _foregroundNotification,
      onOpen: (destination) => unawaited(_openDestination(destination)),
      onDismiss: _dismissForegroundNotification,
      child: child,
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return MaterialApp(
        title: 'Overseer Mobile',
        theme: AppTheme.dark,
        home: const AuthRestoringPage(),
        builder: (context, child) =>
            _withForegroundSurface(child ?? const SizedBox.shrink()),
      );
    }

    final selectedConnection = _selectedConnection;
    if (selectedConnection != null) {
      return AppDependencies(
        key: ValueKey(selectedConnection.id),
        config: _environmentConfig.withServerUrl(selectedConnection.serverUrl),
        connection: selectedConnection,
        notificationRouteStore: _notificationRouteStore,
        child: OverseerMobileApp(
          navigationDestination: _navigationDestination,
          navigationRevision: _navigationRevision,
          foregroundNotification: _foregroundNotification,
          onOpenNotification: (destination) =>
              unawaited(_openDestination(destination)),
          onDismissNotification: _dismissForegroundNotification,
        ),
      );
    }

    if (_adding) {
      return MaterialApp(
        title: 'Overseer Mobile',
        theme: AppTheme.dark,
        home: ServerSetupPage(
          initialUrl: _environmentConfig.serverUrl.toString(),
          onContinue: _add,
          onBack: () => setState(() => _adding = false),
        ),
        builder: (context, child) =>
            _withForegroundSurface(child ?? const SizedBox.shrink()),
      );
    }

    return MaterialApp(
      title: 'Overseer Mobile',
      theme: AppTheme.dark,
      home: OverseerConnectionsPage(
        connections: _connections,
        onAdd: () => setState(() => _adding = true),
        onSelect: _select,
      ),
      builder: (context, child) =>
          _withForegroundSurface(child ?? const SizedBox.shrink()),
    );
  }
}
