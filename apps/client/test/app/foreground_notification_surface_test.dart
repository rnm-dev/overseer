import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/app/app.dart';
import 'package:overseer_mobile/core/notifications/notification_routing.dart';

void main() {
  const destination = NotificationDestination.session(
    workspaceId: 'workspace',
    peonId: 'peon',
    sessionId: 'session',
  );
  const notification = InAppNotification(
    title: 'Session needs attention',
    body: 'The agent is waiting for your response.',
    destination: destination,
  );

  testWidgets('shows a tappable foreground notification without hiding app', (
    tester,
  ) async {
    NotificationDestination? opened;
    await tester.pumpWidget(
      MaterialApp(
        home: ForegroundNotificationSurface(
          notification: notification,
          onOpen: (value) => opened = value,
          child: const Scaffold(body: Text('Cached session content')),
        ),
      ),
    );

    expect(find.text('Cached session content'), findsOneWidget);
    expect(find.text('Session needs attention'), findsOneWidget);
    expect(
      find.text('The agent is waiting for your response.'),
      findsOneWidget,
    );

    await tester.tap(find.byKey(const Key('foreground-notification')));
    expect(opened, destination);
  });

  testWidgets('dismiss action removes the surface through its owner', (
    tester,
  ) async {
    InAppNotification? current = notification;
    late StateSetter setState;
    await tester.pumpWidget(
      MaterialApp(
        home: StatefulBuilder(
          builder: (context, update) {
            setState = update;
            return ForegroundNotificationSurface(
              notification: current,
              onDismiss: () => setState(() => current = null),
              child: const Scaffold(),
            );
          },
        ),
      ),
    );

    await tester.tap(find.byKey(const Key('dismiss-foreground-notification')));
    await tester.pump();

    expect(find.byKey(const Key('foreground-notification')), findsNothing);
  });
}
