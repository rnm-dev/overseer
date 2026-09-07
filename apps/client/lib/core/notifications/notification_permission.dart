import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:firebase_messaging/firebase_messaging.dart';

enum NotificationPermissionStatus {
  checking,
  enabled,
  notDetermined,
  denied,
  unavailable,
}

abstract interface class NotificationPermissionGateway {
  Future<NotificationPermissionStatus> status();

  Future<NotificationPermissionStatus> request();

  Future<bool> openSettings();
}

final notificationPermissionGatewayProvider =
    Provider<NotificationPermissionGateway>(
      (ref) => const NoopNotificationPermissionGateway(),
    );

class NoopNotificationPermissionGateway
    implements NotificationPermissionGateway {
  const NoopNotificationPermissionGateway();

  @override
  Future<bool> openSettings() async => false;

  @override
  Future<NotificationPermissionStatus> request() async =>
      NotificationPermissionStatus.unavailable;

  @override
  Future<NotificationPermissionStatus> status() async =>
      NotificationPermissionStatus.unavailable;
}

class FirebaseNotificationPermissionGateway
    implements NotificationPermissionGateway {
  FirebaseNotificationPermissionGateway({FirebaseMessaging? messaging})
    : _messaging = messaging ?? FirebaseMessaging.instance;

  static const _settingsChannel = MethodChannel(
    'dev.rnm.overseer/notification-settings',
  );

  final FirebaseMessaging _messaging;

  @override
  Future<bool> openSettings() async {
    return await _settingsChannel.invokeMethod<bool>('open') ?? false;
  }

  @override
  Future<NotificationPermissionStatus> request() async {
    final settings = await _messaging.requestPermission(
      alert: true,
      badge: true,
      sound: true,
    );
    return _map(settings.authorizationStatus);
  }

  @override
  Future<NotificationPermissionStatus> status() async {
    final settings = await _messaging.getNotificationSettings();
    return _map(settings.authorizationStatus);
  }

  NotificationPermissionStatus _map(AuthorizationStatus status) {
    return switch (status) {
      AuthorizationStatus.authorized ||
      AuthorizationStatus.provisional => NotificationPermissionStatus.enabled,
      AuthorizationStatus.notDetermined =>
        NotificationPermissionStatus.notDetermined,
      AuthorizationStatus.denied || AuthorizationStatus.deniedPermanently =>
        NotificationPermissionStatus.denied,
    };
  }
}
