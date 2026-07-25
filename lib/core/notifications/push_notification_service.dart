import 'package:flutter_riverpod/flutter_riverpod.dart';

enum PushPlatform {
  android('android'),
  ios('ios');

  const PushPlatform(this.apiValue);

  final String apiValue;
}

abstract interface class PushMessagingClient {
  String get appId;

  Stream<String> get onTokenRefresh;

  Future<bool> requestPermission();

  Future<void> configureForegroundPresentation();

  Future<String?> getToken();
}

abstract interface class PushSubscriptionRemote {
  Future<String> register({
    required String authToken,
    required PushPlatform platform,
    required String pushToken,
    required String appId,
  });

  Future<void> delete({
    required String authToken,
    required String subscriptionId,
  });
}

abstract interface class PushNotificationService {
  Future<void> setAuthToken(String? authToken);

  Future<void> dispose();
}

final pushNotificationServiceProvider = Provider<PushNotificationService>(
  (ref) => const NoopPushNotificationService(),
);

class NoopPushNotificationService implements PushNotificationService {
  const NoopPushNotificationService();

  @override
  Future<void> dispose() async {}

  @override
  Future<void> setAuthToken(String? authToken) async {}
}
