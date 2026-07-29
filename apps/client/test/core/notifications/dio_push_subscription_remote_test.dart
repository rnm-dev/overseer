import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/notifications/dio_push_subscription_remote.dart';
import 'package:overseer_mobile/core/notifications/push_notification_service.dart';

void main() {
  test('uses the authenticated FCM subscription contract', () async {
    final requests = <RequestOptions>[];
    final dio = Dio();
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          requests.add(options);
          handler.resolve(
            Response<Map<String, dynamic>>(
              requestOptions: options,
              data: options.method == 'PUT'
                  ? {
                      'subscription': {'id': 'subscription-id'},
                    }
                  : null,
              statusCode: options.method == 'PUT' ? 201 : 200,
            ),
          );
        },
      ),
    );
    final remote = DioPushSubscriptionRemote(
      apiUrl: Uri.parse('https://overseer.example/api/'),
      dio: dio,
    );

    final id = await remote.register(
      authToken: 'auth-token',
      platform: PushPlatform.android,
      pushToken: 'fcm-token-with-valid-length',
      appId: 'firebase-app-id',
    );
    await remote.delete(authToken: 'auth-token', subscriptionId: id);

    expect(id, 'subscription-id');
    expect(requests.first.method, 'PUT');
    expect(requests.first.path, 'push/subscriptions');
    expect(requests.first.headers['Authorization'], 'Bearer auth-token');
    expect(requests.first.data, {
      'provider': 'fcm',
      'platform': 'android',
      'token': 'fcm-token-with-valid-length',
      'appId': 'firebase-app-id',
    });
    expect(requests.last.method, 'DELETE');
    expect(requests.last.path, 'push/subscriptions/subscription-id');
  });
}
