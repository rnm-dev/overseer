import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/app/app_bootstrap.dart';
import 'package:overseer_mobile/core/config/app_config.dart';
import 'package:overseer_mobile/core/config/overseer_connection_store.dart';
import 'package:overseer_mobile/core/notifications/notification_routing.dart';

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

  testWidgets('adds a connection and returns to the selectable list', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      AppBootstrap(
        store: _FakeConnectionStore(),
        environmentConfig: AppConfig.forFlavor(flavor: 'dev'),
      ),
    );
    await tester.pump();

    await tester.tap(find.byKey(const Key('empty-add-overseer-button')));
    await tester.pump();
    expect(find.byType(TextField), findsOneWidget);

    await tester.enterText(
      find.byType(TextField),
      'https://self-hosted.example/',
    );
    await tester.tap(find.byKey(const Key('server-setup-continue')));
    await tester.pump();
    await tester.pump();

    expect(find.text('self-hosted.example'), findsOneWidget);
    expect(find.text('https://self-hosted.example'), findsOneWidget);
    expect(find.text('Choose an Overseer to continue.'), findsOneWidget);
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

  testWidgets('falls back to the empty state when preferences cannot be read', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      AppBootstrap(
        store: _FailingConnectionStore(),
        environmentConfig: AppConfig.forFlavor(flavor: 'prod'),
      ),
    );
    await tester.pump();

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
          find.byKey(const Key('auth-restoring-logo')).evaluate().length,
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
}

class _FailingConnectionStore implements OverseerConnectionStore {
  @override
  Future<List<OverseerConnection>> add(Uri serverUrl) async =>
      <OverseerConnection>[];

  @override
  Future<List<OverseerConnection>> readAll() =>
      Future<List<OverseerConnection>>.error(StateError('read failed'));
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
