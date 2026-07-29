import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';

import 'push_notification_service.dart';

class FirebasePushMessagingClient implements PushMessagingClient {
  FirebasePushMessagingClient({FirebaseMessaging? messaging})
    : _messaging = messaging ?? FirebaseMessaging.instance;

  final FirebaseMessaging _messaging;

  @override
  String get appId => Firebase.app().options.appId;

  @override
  Stream<String> get onTokenRefresh => _messaging.onTokenRefresh;

  @override
  Future<void> configureForegroundPresentation() {
    return _messaging.setForegroundNotificationPresentationOptions(
      // Foreground messages use the shared in-app surface on both platforms.
      // Keep the badge, but avoid showing a duplicate iOS system banner.
      alert: false,
      badge: true,
      sound: false,
    );
  }

  @override
  Future<String?> getToken() => _messaging.getToken();

  @override
  Future<bool> requestPermission() async {
    final settings = await _messaging.requestPermission(
      alert: true,
      badge: true,
      sound: true,
    );
    return settings.authorizationStatus == AuthorizationStatus.authorized ||
        settings.authorizationStatus == AuthorizationStatus.provisional;
  }
}
