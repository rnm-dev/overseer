import 'package:dio/dio.dart';

extension ServerErrorMessage on DioException {
  /// The `error` string of a JSON error body, when the server sent one.
  String? get serverMessage {
    final data = response?.data;
    return data is Map && data['error'] is String
        ? data['error'] as String
        : null;
  }
}
