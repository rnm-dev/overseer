import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/notifications/notification_permission.dart';
import '../../../core/notifications/push_notification_service.dart';
import '../../auth/application/auth_controller.dart';

final notificationPermissionControllerProvider =
    NotifierProvider<
      NotificationPermissionController,
      NotificationPermissionStatus
    >(NotificationPermissionController.new);

class NotificationPermissionController
    extends Notifier<NotificationPermissionStatus> {
  @override
  NotificationPermissionStatus build() {
    unawaited(Future<void>.microtask(refresh));
    return NotificationPermissionStatus.checking;
  }

  Future<void> refresh() async {
    try {
      state = await ref.read(notificationPermissionGatewayProvider).status();
    } catch (_) {
      state = NotificationPermissionStatus.unavailable;
    }
  }

  Future<NotificationPermissionStatus> request() async {
    state = NotificationPermissionStatus.checking;
    try {
      final result = await ref
          .read(notificationPermissionGatewayProvider)
          .request();
      state = result;
      if (result == NotificationPermissionStatus.enabled) {
        final token = ref.read(authControllerProvider).session?.token;
        if (token != null) {
          await ref.read(pushNotificationServiceProvider).setAuthToken(token);
        }
      }
      return result;
    } catch (_) {
      state = NotificationPermissionStatus.denied;
      return state;
    }
  }

  Future<bool> openSettings() {
    return ref.read(notificationPermissionGatewayProvider).openSettings();
  }
}
