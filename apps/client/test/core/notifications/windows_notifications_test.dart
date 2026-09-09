import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_local_notifications_platform_interface/flutter_local_notifications_platform_interface.dart';
import 'package:flutter_local_notifications_windows/flutter_local_notifications_windows.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:overseer_mobile/core/notifications/notification_permission.dart';
import 'package:overseer_mobile/core/notifications/windows_notifications.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('dev.rnm.overseer/notification-settings');
  late _Plugin plugin;
  late WindowsNotifications notifications;
  late bool osEnabled;
  late List<String> nativeCalls;
  const completion = <String, dynamic>{
    'peonId': 'p1',
    'sessionId': 's1',
    'unread': true,
    'completedAt': 123,
  };

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    plugin = _Plugin();
    notifications = WindowsNotifications(plugin: plugin);
    osEnabled = true;
    nativeCalls = [];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          nativeCalls.add(call.method);
          return call.method == 'status' ? osEnabled : true;
        });
  });

  test(
    'toggle persists opt-in, sends a test banner and stops delivery when off',
    () async {
      expect(
        await notifications.status(),
        NotificationPermissionStatus.notDetermined,
      );
      await notifications.showAttention('w1', completion);
      expect(plugin.shown, isEmpty);
      expect(
        await notifications.request(),
        NotificationPermissionStatus.enabled,
      );
      expect(plugin.shown.single.$1, 0);
      plugin.shown.clear();
      await notifications.showAttention('w1', completion);
      expect(
        plugin.shown.single.$2,
        '/session?workspaceId=w1&peonId=p1&sessionId=s1',
      );
      await notifications.disable();
      await notifications.showAttention('w1', completion);
      expect(plugin.shown, hasLength(1));
      expect(
        (await SharedPreferences.getInstance()).getBool(
          WindowsNotifications.preferenceKey,
        ),
        false,
      );
    },
  );

  test('OS denial is reported and does not send a notification', () async {
    osEnabled = false;
    expect(await notifications.request(), NotificationPermissionStatus.denied);
    await notifications.showAttention('w1', completion);
    expect(plugin.shown, isEmpty);
    await notifications.openSettings();
    expect(nativeCalls, contains('open'));
    osEnabled = true;
    expect(await notifications.status(), NotificationPermissionStatus.enabled);
  });

  test('first delivery establishes a new Windows permission record', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          if (call.method == 'status') {
            return plugin.shown.isEmpty ? null : true;
          }
          return null;
        });
    expect(await notifications.request(), NotificationPermissionStatus.enabled);
    expect(plugin.shown.single.$1, 0);
  });

  test(
    'requests, receipts and invalid routing fields never generate alerts',
    () async {
      await notifications.request();
      plugin.shown.clear();
      for (final event in [
        {...completion, 'completedAt': null},
        {...completion, 'completedAt': double.nan},
        {...completion, 'unread': false},
        {...completion, 'sessionId': ''},
      ]) {
        await notifications.showAttention('w1', event);
      }
      expect(plugin.shown, isEmpty);
    },
  );

  test(
    'valid notification click routes to the session and activates the window',
    () async {
      await notifications.status();
      final opened = notifications.openedDestinations.first;
      plugin.callback!(
        const NotificationResponse(
          notificationResponseType:
              NotificationResponseType.selectedNotification,
          payload: '/session?workspaceId=w1&peonId=p1&sessionId=s1',
        ),
      );
      expect((await opened).sessionId, 's1');
      await Future<void>.delayed(Duration.zero);
      expect(nativeCalls, contains('activate'));
    },
  );

  test('initialization failure can be retried', () async {
    plugin.initializeResult = false;
    await expectLater(notifications.status(), throwsStateError);
    plugin.initializeResult = true;
    expect(
      await notifications.status(),
      NotificationPermissionStatus.notDetermined,
    );
  });

  test(
    'sign-out during a permission check suppresses the pending alert',
    () async {
      await notifications.request();
      plugin.shown.clear();
      final checking = Completer<void>();
      final permission = Completer<bool>();
      var authenticated = true;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (_) {
            checking.complete();
            return permission.future;
          });
      final delivery = notifications.showAttention(
        'w1',
        completion,
        isCurrent: () => authenticated,
      );
      await checking.future;
      authenticated = false;
      permission.complete(true);
      await delivery;
      expect(plugin.shown, isEmpty);
    },
  );
}

class _Plugin implements FlutterLocalNotificationsWindows {
  bool initializeResult = true;
  DidReceiveNotificationResponseCallback? callback;
  final shown = <(int, String?)>[];

  @override
  Future<bool> initialize({
    required WindowsInitializationSettings settings,
    DidReceiveNotificationResponseCallback? onDidReceiveNotificationResponse,
  }) async {
    callback = onDidReceiveNotificationResponse;
    return initializeResult;
  }

  @override
  Future<void> show({
    required int id,
    String? title,
    String? body,
    String? payload,
    WindowsNotificationDetails? notificationDetails,
  }) async {
    shown.add((id, payload));
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
