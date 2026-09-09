import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:overseer_mobile/core/notifications/notification_permission.dart';
import 'package:overseer_mobile/core/notifications/windows_notifications.dart';

/// Native-host check. Displays a real Windows confirmation banner, without
/// accessing an Overseer connection, account, or cached session.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('Windows native notification registration, status and delivery', (
    tester,
  ) async {
    final preferences = await SharedPreferences.getInstance();
    final previous = preferences.getBool(WindowsNotifications.preferenceKey);
    addTearDown(() async {
      if (previous == null) {
        await preferences.remove(WindowsNotifications.preferenceKey);
      } else {
        await preferences.setBool(WindowsNotifications.preferenceKey, previous);
      }
    });
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(body: Center(child: Text('Windows notification check'))),
      ),
    );
    final notifications = WindowsNotifications();
    await notifications.initialDestination();
    expect(
      await notifications.request(),
      NotificationPermissionStatus.enabled,
      reason:
          'Windows must allow notifications for Overseer for this native smoke check.',
    );
    expect(
      await notifications.disable(),
      NotificationPermissionStatus.notDetermined,
    );
    expect(
      await notifications.status(),
      NotificationPermissionStatus.notDetermined,
    );
  }, skip: kIsWeb || defaultTargetPlatform != TargetPlatform.windows);
}
