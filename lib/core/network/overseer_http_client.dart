import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

const overseerHttpConnectTimeout = Duration(seconds: 30);
const overseerHttpReceiveTimeout = Duration(seconds: 30);

/// Creates the consistently configured REST client used for an Overseer
/// connection.
Dio createOverseerHttpClient({required Uri apiUrl, required String token}) {
  return Dio(
    BaseOptions(
      baseUrl: apiUrl.toString(),
      connectTimeout: overseerHttpConnectTimeout,
      receiveTimeout: overseerHttpReceiveTimeout,
      headers: {'Accept': 'application/json', 'Authorization': 'Bearer $token'},
    ),
  );
}

/// The authenticated, connection-scoped REST client installed by the app
/// composition root.
final overseerHttpClientProvider = Provider<Dio>((ref) {
  throw StateError(
    'overseerHttpClientProvider must be overridden for a connection.',
  );
});
