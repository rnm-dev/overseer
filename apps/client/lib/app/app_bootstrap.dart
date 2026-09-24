import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:overseer_mobile/l10n/l10n.dart';
import 'package:overseer_mobile/app/app.dart';
import 'package:overseer_mobile/app/app_dependencies.dart';
import 'package:overseer_mobile/app/overseer_connection_authenticator.dart';
import 'package:overseer_mobile/features/shell/shell.dart';
import 'package:overseer_mobile/core/config/app_config.dart';
import 'package:overseer_mobile/core/config/overseer_connection_store.dart';
import 'package:overseer_mobile/core/notifications/notification_routing.dart';
import 'package:overseer_mobile/core/notifications/desktop_notifications.dart';
import 'package:overseer_mobile/core/security/connection_credential_cleaner.dart';
import 'package:overseer_mobile/features/auth/presentation/overseer_connections_page.dart';
import 'package:overseer_mobile/shared/design/theme.dart';

typedef OverseerConnectionAppBuilder =
    Widget Function(
      AppConfig config,
      OverseerConnection connection,
      VoidCallback? onAuthenticated,
      VoidCallback onBackToConnections,
    );

class AppBootstrap extends StatefulWidget {
  const AppBootstrap({
    super.key,
    this.store,
    this.environmentConfig,
    this.notificationGateway = const NoopNotificationMessageGateway(),
    this.notificationRouteStore,
    this.desktopNotifications,
    this.credentialCleaner,
    this.connectionAuthenticator = authenticateOverseerConnection,
    this.connectionAppBuilder,
  });

  final OverseerConnectionStore? store;
  final AppConfig? environmentConfig;
  final NotificationMessageGateway notificationGateway;
  final NotificationRouteStore? notificationRouteStore;
  final DesktopNotifications? desktopNotifications;
  final ConnectionCredentialCleaner? credentialCleaner;
  final OverseerConnectionAuthenticator connectionAuthenticator;
  final OverseerConnectionAppBuilder? connectionAppBuilder;

  @override
  State<AppBootstrap> createState() => _AppBootstrapState();
}

class _AppBootstrapState extends State<AppBootstrap>
    with WidgetsBindingObserver {
  late final OverseerConnectionStore _store;
  late final AppConfig _environmentConfig;
  late final NotificationRouteStore _notificationRouteStore;
  late final ConnectionCredentialCleaner _credentialCleaner;
  List<OverseerConnection> _connections = const <OverseerConnection>[];
  OverseerConnection? _selectedConnection;
  NotificationDestination? _navigationDestination;
  int _navigationRevision = 0;
  InAppNotification? _foregroundNotification;
  StreamSubscription<InAppNotification>? _foregroundSubscription;
  StreamSubscription<NotificationDestination>? _openedSubscription;
  Timer? _foregroundTimer;
  bool _loading = true;
  bool _restoreFailed = false;

  @override
  void initState() {
    super.initState();
    _store = widget.store ?? SharedPreferencesOverseerConnectionStore();
    _environmentConfig =
        widget.environmentConfig ?? AppConfig.fromEnvironment();
    _notificationRouteStore =
        widget.notificationRouteStore ??
        SharedPreferencesNotificationRouteStore();
    _credentialCleaner =
        widget.credentialCleaner ?? const SecureConnectionCredentialCleaner();
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
    if (mounted) {
      setState(() {
        _loading = true;
        _restoreFailed = false;
      });
    }
    List<OverseerConnection> connections;
    try {
      connections = await _store.readAll();
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _restoreFailed = true;
      });
      return;
    }
    if (!mounted) return;
    setState(() {
      _connections = connections;
      _loading = false;
      _restoreFailed = false;
    });
    final destination = _navigationDestination;
    if (destination != null && _selectedConnection == null) {
      await _openDestination(destination);
    }
  }

  Future<void> _beginAdd(Uri serverUrl) async {
    final normalized = normalizeOverseerServerUrl(serverUrl);
    if (_connections.any((item) => item.serverUrl == normalized)) {
      throw const DuplicateOverseerConnectionException();
    }
    final connection = OverseerConnection(serverUrl: normalized);
    final config = _environmentConfig.withServerUrl(normalized);
    await widget.connectionAuthenticator(config, connection);
    final connections = await _store.add(normalized);
    if (!mounted) return;
    setState(() {
      _connections = connections;
      _selectedConnection = connection;
    });
  }

  Future<void> _delete(OverseerConnection connection) async {
    await _credentialCleaner.delete(connection);
    final connections = await _store.remove(connection);
    if (!mounted) return;
    setState(() => _connections = connections);
  }

  void _returnToConnections() {
    setState(() {
      _selectedConnection = null;
      _navigationDestination = null;
      _navigationRevision += 1;
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
        onGenerateTitle: (context) => context.l10n.appTitle,
        localizationsDelegates: const [
          AppLocalizations.delegate,
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        supportedLocales: AppLocalizations.supportedLocales,
        theme: AppTheme.dark,
        home: const OverseerConnectionsLoadingPage(),
        builder: (context, child) =>
            _withForegroundSurface(child ?? const SizedBox.shrink()),
      );
    }

    if (_restoreFailed) {
      return MaterialApp(
        onGenerateTitle: (context) => context.l10n.appTitle,
        localizationsDelegates: const [
          AppLocalizations.delegate,
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        supportedLocales: AppLocalizations.supportedLocales,
        theme: AppTheme.dark,
        home: OverseerConnectionsRestoreErrorPage(onRetry: _restore),
        builder: (context, child) =>
            _withForegroundSurface(child ?? const SizedBox.shrink()),
      );
    }

    final selectedIndex = _selectedConnection == null
        ? 0
        : _connections.indexWhere(
                (item) => item.serverUrl == _selectedConnection!.serverUrl,
              ) +
              1;
    return Directionality(
      textDirection: TextDirection.ltr,
      child: IndexedStack(
        alignment: Alignment.topLeft,
        index: selectedIndex < 0 ? 0 : selectedIndex,
        children: [
          _buildConnectionPicker(),
          for (final connection in _connections)
            _buildConnectionApp(connection),
        ],
      ),
    );
  }

  Widget _buildConnectionPicker() {
    return MaterialApp(
      onGenerateTitle: (context) => context.l10n.appTitle,
      localizationsDelegates: const [
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      supportedLocales: AppLocalizations.supportedLocales,
      theme: AppTheme.dark,
      home: OverseerConnectionsPage(
        connections: _connections,
        initialUrl: _environmentConfig.serverUrl.toString(),
        onAdd: _beginAdd,
        onSelect: _select,
        onDelete: _delete,
      ),
      builder: (context, child) =>
          _withForegroundSurface(child ?? const SizedBox.shrink()),
    );
  }

  Widget _buildConnectionApp(OverseerConnection connection) {
    final config = _environmentConfig.withServerUrl(connection.serverUrl);
    final isSelected = _selectedConnection?.serverUrl == connection.serverUrl;
    final appBuilder = widget.connectionAppBuilder;
    final child = appBuilder != null
        ? appBuilder(config, connection, null, _returnToConnections)
        : AppDependencies(
            key: ValueKey(connection.id),
            config: config,
            connection: connection,
            overseerSwitcher: OverseerSwitcherData(
              connections: _connections,
              current: connection,
              onSelect: _select,
              onManage: _returnToConnections,
            ),
            notificationRouteStore: _notificationRouteStore,
            desktopNotifications: widget.desktopNotifications,
            child: OverseerMobileApp(
              onBackToConnections: _returnToConnections,
              overseerName: connection.title,
              navigationDestination: isSelected ? _navigationDestination : null,
              navigationRevision: _navigationRevision,
              foregroundNotification: _foregroundNotification,
              onOpenNotification: (destination) =>
                  unawaited(_openDestination(destination)),
              onDismissNotification: _dismissForegroundNotification,
            ),
          );
    return KeyedSubtree(
      key: ValueKey(connection.id),
      child: TickerMode(enabled: isSelected, child: child),
    );
  }
}
