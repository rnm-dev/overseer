import 'notification_permission.dart';
import 'notification_routing.dart';

/// Desktop delivery uses the authenticated live connection, not an FCM token.
abstract interface class DesktopNotifications
    implements NotificationMessageGateway, NotificationPermissionGateway {
  Future<NotificationPermissionStatus> disable();

  Future<void> showAttention(
    String workspaceId,
    Map<String, dynamic> event, {
    bool Function()? isCurrent,
  });
}
