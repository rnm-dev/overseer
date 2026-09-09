import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_local_notifications_windows/flutter_local_notifications_windows.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'desktop_notifications.dart';
import 'notification_permission.dart';
import 'notification_routing.dart';

class WindowsNotifications implements DesktopNotifications {
  WindowsNotifications({FlutterLocalNotificationsWindows? plugin})
    : _plugin = plugin ?? FlutterLocalNotificationsWindows();

  static const appId = 'org.ovrseer.app';
  static const preferenceKey = 'overseer.windows.notifications.enabled';
  static const _channel = MethodChannel(
    'dev.rnm.overseer/notification-settings',
  );
  final FlutterLocalNotificationsWindows _plugin;
  final _opened = StreamController<NotificationDestination>.broadcast();
  Future<void>? _initialization;
  int _nextId = 0;

  Future<void> _initialize() => _initialization ??= _initializePlugin();

  Future<void> _initializePlugin() async {
    try {
      await _channel.invokeMethod<void>('register');
      final initialized = await _plugin.initialize(
        settings: const WindowsInitializationSettings(
          appName: 'Overseer',
          appUserModelId: appId,
          guid: '38a75d22-1b46-4a36-92b7-a871455b8297',
        ),
        onDidReceiveNotificationResponse: (response) {
          final uri = Uri.tryParse(response.payload ?? '');
          final destination = uri == null
              ? null
              : NotificationDestination.fromUri(uri);
          if (destination == null) return;
          _opened.add(destination);
          unawaited(_channel.invokeMethod<void>('activate').catchError((_) {}));
        },
      );
      if (!initialized) throw StateError('Windows notifications unavailable');
    } catch (_) {
      _initialization = null;
      rethrow;
    }
  }

  @override
  Stream<InAppNotification> get foregroundNotifications => const Stream.empty();

  @override
  Stream<NotificationDestination> get openedDestinations => _opened.stream;

  @override
  Future<NotificationDestination?> initialDestination() async {
    await _initialize();
    final details = await _plugin.getNotificationAppLaunchDetails();
    final uri = Uri.tryParse(details?.notificationResponse?.payload ?? '');
    return uri == null ? null : NotificationDestination.fromUri(uri);
  }

  @override
  Future<NotificationPermissionStatus> status() async {
    await _initialize();
    final preferences = await SharedPreferences.getInstance();
    if (!(preferences.getBool(preferenceKey) ?? false)) {
      return NotificationPermissionStatus.notDetermined;
    }
    final enabled = await _channel.invokeMethod<bool>('status');
    if (enabled == null) return NotificationPermissionStatus.notDetermined;
    return enabled == true
        ? NotificationPermissionStatus.enabled
        : NotificationPermissionStatus.denied;
  }

  @override
  Future<NotificationPermissionStatus> request() async {
    await _initialize();
    final preferences = await SharedPreferences.getInstance();
    await preferences.setBool(preferenceKey, true);
    final result = await status();
    if (result == NotificationPermissionStatus.enabled ||
        result == NotificationPermissionStatus.notDetermined) {
      await _plugin.show(
        id: 0,
        title: 'Overseer notifications enabled',
        body:
            'Session completion alerts will appear while Overseer is running.',
      );
      return status();
    }
    return result;
  }

  @override
  Future<NotificationPermissionStatus> disable() async {
    final preferences = await SharedPreferences.getInstance();
    await preferences.setBool(preferenceKey, false);
    return NotificationPermissionStatus.notDetermined;
  }

  @override
  Future<bool> openSettings() async =>
      await _channel.invokeMethod<bool>('open') ?? false;

  @override
  Future<void> showAttention(
    String workspaceId,
    Map<String, dynamic> event, {
    bool Function()? isCurrent,
  }) async {
    // Match the server's push rule: requests and read receipts are not alerts.
    final completedAt = event['completedAt'];
    if (event['unread'] != true ||
        completedAt is! num ||
        !completedAt.isFinite ||
        completedAt <= 0) {
      return;
    }
    final destination = NotificationDestination.fromData({
      ...event,
      'kind': 'attention',
      'workspaceId': workspaceId,
    });
    if (destination == null ||
        await status() != NotificationPermissionStatus.enabled ||
        !(isCurrent?.call() ?? true)) {
      return;
    }
    await _plugin.show(
      id: ++_nextId,
      title: 'Overseer — session finished',
      body: 'Your run has finished. Open the session to see the result.',
      payload: destination.location,
    );
  }
}
