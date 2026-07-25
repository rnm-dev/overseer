import 'package:dio/dio.dart';

import 'push_notification_service.dart';

class DioPushSubscriptionRemote implements PushSubscriptionRemote {
  DioPushSubscriptionRemote({required Uri apiUrl, Dio? dio})
    : _dio =
          dio ??
          Dio(
            BaseOptions(
              baseUrl: apiUrl.toString(),
              connectTimeout: const Duration(seconds: 30),
              receiveTimeout: const Duration(seconds: 30),
              headers: const {'Accept': 'application/json'},
            ),
          );

  final Dio _dio;

  @override
  Future<String> register({
    required String authToken,
    required PushPlatform platform,
    required String pushToken,
    required String appId,
  }) async {
    final response = await _dio.put<Map<String, dynamic>>(
      'push/subscriptions',
      data: {
        'provider': 'fcm',
        'platform': platform.apiValue,
        'token': pushToken,
        'appId': appId,
      },
      options: Options(headers: {'Authorization': 'Bearer $authToken'}),
    );
    final subscription = response.data?['subscription'];
    final id = subscription is Map ? subscription['id'] : null;
    if (id is! String || id.isEmpty) {
      throw const FormatException('Invalid push subscription response.');
    }
    return id;
  }

  @override
  Future<void> delete({
    required String authToken,
    required String subscriptionId,
  }) async {
    await _dio.delete<void>(
      'push/subscriptions/${Uri.encodeComponent(subscriptionId)}',
      options: Options(headers: {'Authorization': 'Bearer $authToken'}),
    );
  }
}
