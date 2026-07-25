class OperatorIdentity {
  const OperatorIdentity({
    required this.email,
    this.githubLogin,
    this.avatarUrl,
  });

  final String email;
  final String? githubLogin;
  final String? avatarUrl;
}

class AuthSession {
  const AuthSession({required this.token, required this.user});

  final String token;
  final OperatorIdentity user;
}

class AuthException implements Exception {
  const AuthException(this.message);

  final String message;

  @override
  String toString() => message;
}

class RemoteAuthException extends AuthException {
  const RemoteAuthException({
    required this.statusCode,
    required this.code,
    required String message,
  }) : super(message);

  final int? statusCode;
  final String code;
}
