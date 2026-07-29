import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/notifications/notification_permission.dart';
import 'package:overseer_mobile/core/notifications/push_notification_service.dart';
import 'package:overseer_mobile/features/auth/application/auth_controller.dart';
import 'package:overseer_mobile/features/auth/application/auth_state.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';
import 'package:overseer_mobile/features/settings/application/notification_permission_controller.dart';

void main() {
  test(
    'refresh registers push after permission is enabled in settings',
    () async {
      final permissions = _FakeNotificationPermissionGateway();
      final push = _RecordingPushNotificationService();
      final container = ProviderContainer(
        overrides: [
          authControllerProvider.overrideWith(_AuthenticatedAuthController.new),
          notificationPermissionGatewayProvider.overrideWithValue(permissions),
          pushNotificationServiceProvider.overrideWithValue(push),
        ],
      );
      addTearDown(container.dispose);

      permissions.current = NotificationPermissionStatus.enabled;
      await container
          .read(notificationPermissionControllerProvider.notifier)
          .refresh();

      expect(
        container.read(notificationPermissionControllerProvider),
        NotificationPermissionStatus.enabled,
      );
      expect(push.authTokens, isNotEmpty);
      expect(push.authTokens, everyElement('device-token'));
    },
  );

  test('registration failure does not hide enabled permission state', () async {
    final permissions = _FakeNotificationPermissionGateway()
      ..current = NotificationPermissionStatus.enabled;
    final container = ProviderContainer(
      overrides: [
        authControllerProvider.overrideWith(_AuthenticatedAuthController.new),
        notificationPermissionGatewayProvider.overrideWithValue(permissions),
        pushNotificationServiceProvider.overrideWithValue(
          _ThrowingPushNotificationService(),
        ),
      ],
    );
    addTearDown(container.dispose);

    await container
        .read(notificationPermissionControllerProvider.notifier)
        .refresh();

    expect(
      container.read(notificationPermissionControllerProvider),
      NotificationPermissionStatus.enabled,
    );
  });
}

class _AuthenticatedAuthController extends AuthController {
  @override
  AuthState build() {
    return const AuthState.authenticated(
      AuthSession(
        token: 'device-token',
        user: OperatorIdentity(email: 'dev@example.com'),
      ),
    );
  }
}

class _FakeNotificationPermissionGateway
    implements NotificationPermissionGateway {
  NotificationPermissionStatus current = NotificationPermissionStatus.denied;

  @override
  Future<bool> openSettings() async => true;

  @override
  Future<NotificationPermissionStatus> request() async => current;

  @override
  Future<NotificationPermissionStatus> status() async => current;
}

class _RecordingPushNotificationService implements PushNotificationService {
  final authTokens = <String?>[];

  @override
  Future<void> dispose() async {}

  @override
  Future<void> setAuthToken(String? authToken) async {
    authTokens.add(authToken);
  }
}

class _ThrowingPushNotificationService implements PushNotificationService {
  @override
  Future<void> dispose() async {}

  @override
  Future<void> setAuthToken(String? authToken) {
    throw StateError('registration failed');
  }
}
