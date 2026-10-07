import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/app/app_bootstrap.dart';
import 'package:overseer_mobile/core/config/app_config.dart';
import 'package:overseer_mobile/core/config/overseer_connection_store.dart';
import 'package:overseer_mobile/core/notifications/notification_routing.dart';
import 'package:overseer_mobile/core/security/connection_credential_cleaner.dart';

void main() {
  testWidgets('shows the empty connection state when nothing is saved', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      AppBootstrap(
        store: _FakeConnectionStore(),
        environmentConfig: AppConfig.forFlavor(flavor: 'dev'),
      ),
    );
    await tester.pump();

    expect(find.text('Overseer connections'), findsOneWidget);
    expect(find.text('No connections yet'), findsOneWidget);
    expect(find.text('Add Overseer'), findsOneWidget);
    expect(find.text('Sign In'), findsNothing);
  });

  testWidgets('keeps add form visible until authentication succeeds', (
    WidgetTester tester,
  ) async {
    final store = _FakeConnectionStore();
    final authentication = Completer<void>();
    var appBuilds = 0;
    await tester.pumpWidget(
      AppBootstrap(
        store: store,
        environmentConfig: AppConfig.forFlavor(flavor: 'dev'),
        credentialCleaner: const _NoopCredentialCleaner(),
        connectionAuthenticator: (_, _) => authentication.future,
        connectionAppBuilder:
            (config, connection, onAuthenticated, onBackToConnections) {
              appBuilds += 1;
              expect(onAuthenticated, isNull);
              return const MaterialApp(
                home: Scaffold(body: Text('Authenticated Overseer')),
              );
            },
      ),
    );
    await tester.pump();

    await tester.tap(find.byKey(const Key('empty-add-overseer-button')));
    await tester.pumpAndSettle();
    expect(find.byType(TextField), findsOneWidget);

    await tester.enterText(
      find.byType(TextField),
      'https://self-hosted.example/',
    );
    await tester.tap(find.byKey(const Key('server-setup-continue')));
    await tester.pump();

    expect(find.byType(TextField), findsOneWidget);
    expect(find.text('Checking sign-in…'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.byKey(const Key('fleet-loading')), findsNothing);
    expect(find.text('Authenticated Overseer'), findsNothing);
    expect(appBuilds, 0);
    expect(await store.readAll(), isEmpty);

    authentication.complete();
    await tester.pumpAndSettle();

    expect(find.text('Authenticated Overseer'), findsOneWidget);
    expect(appBuilds, 1);
    expect(
      (await store.readAll()).single.serverUrl,
      Uri.parse('https://self-hosted.example'),
    );
  });

  testWidgets('failed provisional authentication stays on the add form', (
    WidgetTester tester,
  ) async {
    final store = _FakeConnectionStore();
    await tester.pumpWidget(
      AppBootstrap(
        store: store,
        environmentConfig: AppConfig.forFlavor(flavor: 'dev'),
        credentialCleaner: const _NoopCredentialCleaner(),
        connectionAuthenticator: (_, _) =>
            Future<void>.error(StateError('sign-in cancelled')),
      ),
    );
    await tester.pump();

    await tester.tap(find.byKey(const Key('empty-add-overseer-button')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'https://temporary.example');
    await tester.tap(find.byKey(const Key('server-setup-continue')));
    await tester.pump();
    await tester.pump();

    expect(find.byType(TextField), findsOneWidget);
    expect(
      find.text('The Overseer URL could not be opened. Please try again.'),
      findsOneWidget,
    );
    expect(find.byKey(const Key('fleet-loading')), findsNothing);
    expect(await store.readAll(), isEmpty);
  });

  testWidgets('renders every saved connection', (WidgetTester tester) async {
    await tester.pumpWidget(
      AppBootstrap(
        store: _FakeConnectionStore(<OverseerConnection>[
          OverseerConnection(serverUrl: Uri.parse('https://one.example')),
          OverseerConnection(serverUrl: Uri.parse('http://two.example:3000')),
        ]),
        environmentConfig: AppConfig.forFlavor(flavor: 'prod'),
      ),
    );
    await tester.pump();

    expect(find.text('one.example'), findsOneWidget);
    expect(find.text('two.example'), findsOneWidget);
    expect(find.text('Add Overseer'), findsOneWidget);
  });

  testWidgets('keeps every saved Overseer runtime mounted while switching', (
    WidgetTester tester,
  ) async {
    final connections = <OverseerConnection>[
      OverseerConnection(serverUrl: Uri.parse('https://one.example')),
      OverseerConnection(serverUrl: Uri.parse('https://two.example')),
    ];
    final initialized = <Uri>[];
    final disposed = <Uri>[];
    await tester.pumpWidget(
      AppBootstrap(
        store: _FakeConnectionStore(connections),
        environmentConfig: AppConfig.forFlavor(flavor: 'dev'),
        connectionAppBuilder:
            (config, connection, onAuthenticated, onBackToConnections) {
              return _RuntimeProbe(
                connection: connection,
                onBack: onBackToConnections,
                onInitialized: initialized.add,
                onDisposed: disposed.add,
              );
            },
      ),
    );
    await tester.pump();

    expect(
      initialized,
      unorderedEquals(connections.map((item) => item.serverUrl)),
    );
    expect(disposed, isEmpty);

    await tester.tap(
      find.byKey(const ValueKey('overseer-connection-https://one.example')),
    );
    await tester.pump();
    expect(find.text('Runtime one.example'), findsOneWidget);

    await tester.tap(find.text('Back to connections'));
    await tester.pump();
    await tester.tap(
      find.byKey(const ValueKey('overseer-connection-https://two.example')),
    );
    await tester.pump();

    expect(find.text('Runtime two.example'), findsOneWidget);
    expect(initialized, hasLength(2));
    expect(disposed, isEmpty);
  });

  testWidgets('deletes a connection and its saved credential', (
    WidgetTester tester,
  ) async {
    final connection = OverseerConnection(
      serverUrl: Uri.parse('https://one.example'),
    );
    final store = _FakeConnectionStore(<OverseerConnection>[connection]);
    final cleaner = _RecordingCredentialCleaner();
    await tester.pumpWidget(
      AppBootstrap(
        store: store,
        environmentConfig: AppConfig.forFlavor(flavor: 'dev'),
        credentialCleaner: cleaner,
      ),
    );
    await tester.pump();

    await tester.longPress(
      find.byKey(const ValueKey('overseer-connection-https://one.example')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('overseer-menu-delete')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('confirmation-confirm')));
    await tester.pumpAndSettle();

    expect(cleaner.deleted, same(connection));
    expect(await store.readAll(), isEmpty);
    expect(find.text('No connections yet'), findsOneWidget);
  });

  testWidgets('keeps restore failures distinct from an empty saved list', (
    WidgetTester tester,
  ) async {
    final store = _FailingConnectionStore();
    await tester.pumpWidget(
      AppBootstrap(
        store: store,
        environmentConfig: AppConfig.forFlavor(flavor: 'prod'),
      ),
    );
    await tester.pump();

    expect(find.text('Could not load Overseer connections'), findsOneWidget);
    expect(find.text('No connections yet'), findsNothing);

    store.fail = false;
    await tester.tap(find.byKey(const Key('retry-overseer-connections')));
    await tester.pump();
    await tester.pump();

    expect(find.text('Could not load Overseer connections'), findsNothing);
    expect(find.text('No connections yet'), findsOneWidget);
  });

  testWidgets('notification restoration selects its recorded connection', (
    WidgetTester tester,
  ) async {
    final second = Uri.parse('https://two.example');
    await tester.pumpWidget(
      AppBootstrap(
        store: _FakeConnectionStore(<OverseerConnection>[
          OverseerConnection(serverUrl: Uri.parse('https://one.example')),
          OverseerConnection(serverUrl: second),
        ]),
        environmentConfig: AppConfig.forFlavor(flavor: 'dev'),
        notificationGateway: const _InitialNotificationGateway(
          NotificationDestination.session(
            workspaceId: 'workspace',
            peonId: 'peon',
            sessionId: 'session',
          ),
        ),
        notificationRouteStore: _FakeNotificationRouteStore({
          'workspace': second,
        }),
      ),
    );
    await tester.pump();
    await tester.pump();
    await tester.pump();

    expect(find.text('Overseer connections'), findsNothing);
    expect(
      find.text('Sign In').evaluate().length +
          find.byKey(const Key('fleet-loading')).evaluate().length,
      1,
    );
  });

  testWidgets('foreground notification expires without replacing app content', (
    WidgetTester tester,
  ) async {
    final gateway = _StreamNotificationGateway();
    await tester.pumpWidget(
      AppBootstrap(
        store: _FakeConnectionStore(),
        environmentConfig: AppConfig.forFlavor(flavor: 'dev'),
        notificationGateway: gateway,
      ),
    );
    await tester.pump();

    gateway.foreground.add(
      const InAppNotification(
        title: 'Session updated',
        body: 'Agent signal is active.',
        destination: NotificationDestination.session(
          workspaceId: 'workspace',
          peonId: 'peon',
          sessionId: 'session',
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Overseer connections'), findsOneWidget);
    expect(find.byKey(const Key('foreground-notification')), findsOneWidget);

    await tester.pump(const Duration(seconds: 8));
    expect(find.byKey(const Key('foreground-notification')), findsNothing);

    await gateway.dispose();
  });
}

class _FakeConnectionStore implements OverseerConnectionStore {
  _FakeConnectionStore([
    List<OverseerConnection> connections = const <OverseerConnection>[],
  ]) : _connections = [...connections];

  final List<OverseerConnection> _connections;

  @override
  Future<List<OverseerConnection>> add(Uri serverUrl) async {
    final connection = OverseerConnection(
      serverUrl: normalizeOverseerServerUrl(serverUrl),
    );
    _connections.add(connection);
    return [..._connections];
  }

  @override
  Future<List<OverseerConnection>> readAll() async => [..._connections];

  @override
  Future<List<OverseerConnection>> remove(OverseerConnection connection) async {
    _connections.removeWhere((item) => item.serverUrl == connection.serverUrl);
    return [..._connections];
  }
}

class _FailingConnectionStore implements OverseerConnectionStore {
  bool fail = true;

  @override
  Future<List<OverseerConnection>> add(Uri serverUrl) async =>
      <OverseerConnection>[];

  @override
  Future<List<OverseerConnection>> readAll() async {
    if (fail) throw StateError('read failed');
    return <OverseerConnection>[];
  }

  @override
  Future<List<OverseerConnection>> remove(
    OverseerConnection connection,
  ) async => <OverseerConnection>[];
}

class _NoopCredentialCleaner implements ConnectionCredentialCleaner {
  const _NoopCredentialCleaner();

  @override
  Future<void> delete(OverseerConnection connection) async {}
}

class _RecordingCredentialCleaner implements ConnectionCredentialCleaner {
  OverseerConnection? deleted;

  @override
  Future<void> delete(OverseerConnection connection) async {
    deleted = connection;
  }
}

class _InitialNotificationGateway implements NotificationMessageGateway {
  const _InitialNotificationGateway(this.destination);

  final NotificationDestination destination;

  @override
  Stream<InAppNotification> get foregroundNotifications => const Stream.empty();

  @override
  Stream<NotificationDestination> get openedDestinations =>
      const Stream.empty();

  @override
  Future<NotificationDestination?> initialDestination() async => destination;
}

class _FakeNotificationRouteStore implements NotificationRouteStore {
  _FakeNotificationRouteStore(this.routes);

  final Map<String, Uri> routes;

  @override
  Future<Uri?> connectionForWorkspace(String workspaceId) async =>
      routes[workspaceId];

  @override
  Future<void> recordConnection({
    required OverseerConnection connection,
    required Iterable<String> workspaceIds,
  }) async {
    for (final workspaceId in workspaceIds) {
      routes[workspaceId] = connection.serverUrl;
    }
  }
}

class _StreamNotificationGateway implements NotificationMessageGateway {
  final foreground = StreamController<InAppNotification>.broadcast();
  final opened = StreamController<NotificationDestination>.broadcast();

  Future<void> dispose() async {
    await foreground.close();
    await opened.close();
  }

  @override
  Stream<InAppNotification> get foregroundNotifications => foreground.stream;

  @override
  Stream<NotificationDestination> get openedDestinations => opened.stream;

  @override
  Future<NotificationDestination?> initialDestination() async => null;
}

class _RuntimeProbe extends StatefulWidget {
  const _RuntimeProbe({
    required this.connection,
    required this.onBack,
    required this.onInitialized,
    required this.onDisposed,
  });

  final OverseerConnection connection;
  final VoidCallback onBack;
  final ValueChanged<Uri> onInitialized;
  final ValueChanged<Uri> onDisposed;

  @override
  State<_RuntimeProbe> createState() => _RuntimeProbeState();
}

class _RuntimeProbeState extends State<_RuntimeProbe> {
  @override
  void initState() {
    super.initState();
    widget.onInitialized(widget.connection.serverUrl);
  }

  @override
  void dispose() {
    widget.onDisposed(widget.connection.serverUrl);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        body: Column(
          children: [
            Text('Runtime ${widget.connection.title}'),
            TextButton(
              onPressed: widget.onBack,
              child: const Text('Back to connections'),
            ),
          ],
        ),
      ),
    );
  }
}
