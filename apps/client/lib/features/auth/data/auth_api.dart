import 'package:dio/dio.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';

abstract interface class AuthRemoteDataSource {
  Future<AuthSession> exchangeNativeSignIn({
    required String code,
    required String state,
  });

  Future<OperatorIdentity> me(String token);

  Future<void> logout(String token);
}

class DioAuthRemoteDataSource implements AuthRemoteDataSource {
  DioAuthRemoteDataSource({required Uri apiUrl, Dio? dio})
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
  Future<AuthSession> exchangeNativeSignIn({
    required String code,
    required String state,
  }) async {
    final data = await _request(
      () => _dio.post<Map<String, dynamic>>(
        'auth/github/native/exchange',
        data: {'code': code, 'state': state},
      ),
    );
    return AuthSession(
      token: data['token'] as String,
      user: _operatorFromJson(data['user'] as Map<String, dynamic>),
    );
  }

  @override
  Future<OperatorIdentity> me(String token) async {
    final data = await _request(
      () => _dio.get<Map<String, dynamic>>(
        'auth/me',
        options: Options(headers: {'Authorization': 'Bearer $token'}),
      ),
    );
    return _operatorFromJson(data['user'] as Map<String, dynamic>);
  }

  @override
  Future<void> logout(String token) async {
    await _request(
      () => _dio.post<Map<String, dynamic>>(
        'auth/logout',
        options: Options(headers: {'Authorization': 'Bearer $token'}),
      ),
    );
  }

  Future<Map<String, dynamic>> _request(
    Future<Response<Map<String, dynamic>>> Function() send,
  ) async {
    try {
      final response = await send();
      final data = response.data;
      if (data == null) {
        throw const AuthException('The server returned an empty response.');
      }
      return data;
    } on DioException catch (error) {
      final payload = error.response?.data;
      final message = payload is Map<String, dynamic>
          ? payload['error'] as String?
          : null;
      final code = payload is Map<String, dynamic>
          ? payload['code'] as String?
          : null;
      throw RemoteAuthException(
        statusCode: error.response?.statusCode,
        code: code ?? 'NETWORK_ERROR',
        message:
            message ??
            'Could not reach Overseer. Check your connection and try again.',
      );
    } on FormatException {
      throw const AuthException('The server returned an invalid sign-in URL.');
    } on TypeError {
      throw const AuthException('The server returned an invalid response.');
    }
  }

  OperatorIdentity _operatorFromJson(Map<String, dynamic> json) {
    return OperatorIdentity(
      email: json['email'] as String,
      githubLogin: json['githubLogin'] as String?,
      avatarUrl: json['avatarUrl'] as String?,
    );
  }
}
