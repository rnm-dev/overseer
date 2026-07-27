import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/diagnostics/app_diagnostics.dart';
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
      final result = await ref
          .read(notificationPermissionGatewayProvider)
          .status();
      state = result;
      if (result == NotificationPermissionStatus.enabled) {
        await _registerIfAuthenticated();
      }
    } catch (error) {
      _recordFailure('status', error);
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
        await _registerIfAuthenticated();
      }
      return result;
    } catch (error) {
      _recordFailure('request', error);
      state = NotificationPermissionStatus.denied;
      return state;
    }
  }

  Future<bool> openSettings() {
    return ref.read(notificationPermissionGatewayProvider).openSettings();
  }

  Future<void> _registerIfAuthenticated() async {
    final token = ref.read(authControllerProvider).session?.token;
    if (token == null) return;
    try {
      await ref.read(pushNotificationServiceProvider).setAuthToken(token);
    } catch (error) {
      _recordFailure('registration', error);
      // Push registration must not change the operating-system permission state.
    }
  }

  void _recordFailure(String state, Object error) {
    ref
        .read(appDiagnosticsProvider)
        .record(
          AppDiagnosticEvent(
            name: 'notification.permission',
            level: AppDiagnosticLevel.warning,
            state: state,
            outcome: 'failed',
            errorType: error.runtimeType.toString(),
          ),
        );
  }
}
