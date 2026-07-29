import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/notifications/default_push_notification_service.dart';
import 'package:overseer_mobile/core/notifications/push_notification_service.dart';

void main() {
  test('registers, rotates, and removes the authenticated FCM token', () async {
    final messaging = _FakeMessagingClient();
    final remote = _FakePushSubscriptionRemote();
    final service = DefaultPushNotificationService(
      messaging,
      remote,
      PushPlatform.android,
    );

    await service.setAuthToken('auth-token');

    expect(messaging.permissionRequests, 1);
    expect(remote.registrations.single, (
      authToken: 'auth-token',
      platform: PushPlatform.android,
      pushToken: 'push-token-1',
      appId: 'firebase-app',
    ));

    messaging.refreshes.add('push-token-2');
    await _waitUntil(() => remote.registrations.length == 2);

    expect(remote.deletions, [
      (authToken: 'auth-token', subscriptionId: 'subscription-1'),
    ]);

    await service.setAuthToken(null);

    expect(remote.deletions, [
      (authToken: 'auth-token', subscriptionId: 'subscription-1'),
      (authToken: 'auth-token', subscriptionId: 'subscription-2'),
    ]);
    await service.dispose();
    await messaging.refreshes.close();
  });

  test(
    'does not request a token when notification permission is denied',
    () async {
      final messaging = _FakeMessagingClient(permissionGranted: false);
      final remote = _FakePushSubscriptionRemote();
      final service = DefaultPushNotificationService(
        messaging,
        remote,
        PushPlatform.ios,
      );

      await service.setAuthToken('auth-token');

      expect(messaging.tokenRequests, 0);
      expect(remote.registrations, isEmpty);
      await service.dispose();
      await messaging.refreshes.close();
    },
  );
}

Future<void> _waitUntil(bool Function() condition) async {
  for (var attempt = 0; attempt < 20; attempt++) {
    if (condition()) return;
    await Future<void>.delayed(Duration.zero);
  }
  fail('The asynchronous condition was not reached.');
}

class _FakeMessagingClient implements PushMessagingClient {
  _FakeMessagingClient({this.permissionGranted = true});

  final bool permissionGranted;
  final refreshes = StreamController<String>.broadcast();
  var permissionRequests = 0;
  var tokenRequests = 0;

  @override
  String get appId => 'firebase-app';

  @override
  Stream<String> get onTokenRefresh => refreshes.stream;

  @override
  Future<void> configureForegroundPresentation() async {}

  @override
  Future<String?> getToken() async {
    tokenRequests++;
    return 'push-token-1';
  }

  @override
  Future<bool> requestPermission() async {
    permissionRequests++;
    return permissionGranted;
  }
}

class _FakePushSubscriptionRemote implements PushSubscriptionRemote {
  final registrations =
      <
        ({
          String authToken,
          PushPlatform platform,
          String pushToken,
          String appId,
        })
      >[];
  final deletions = <({String authToken, String subscriptionId})>[];

  @override
  Future<void> delete({
    required String authToken,
    required String subscriptionId,
  }) async {
    deletions.add((authToken: authToken, subscriptionId: subscriptionId));
  }

  @override
  Future<String> register({
    required String authToken,
    required PushPlatform platform,
    required String pushToken,
    required String appId,
  }) async {
    registrations.add((
      authToken: authToken,
      platform: platform,
      pushToken: pushToken,
      appId: appId,
    ));
    return 'subscription-${registrations.length}';
  }
}
