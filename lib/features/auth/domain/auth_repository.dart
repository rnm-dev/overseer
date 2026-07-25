import 'package:overseer_mobile/features/auth/domain/auth_models.dart';

const githubOAuthCallbackScheme = 'overseer';
const githubOAuthCallbackUrl = '$githubOAuthCallbackScheme://oauth/github';

abstract interface class AuthRepository {
  Future<AuthSession?> restore();

  Future<AuthSession> signIn();

  Future<void> signOut();
}
