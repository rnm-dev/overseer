import 'package:overseer_mobile/core/security/device_token_store.dart';
import 'package:overseer_mobile/features/auth/data/auth_api.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';
import 'package:overseer_mobile/features/auth/domain/auth_repository.dart';
import 'package:overseer_mobile/features/auth/domain/oauth_browser.dart';

class DefaultAuthRepository implements AuthRepository {
  DefaultAuthRepository({
    required AuthRemoteDataSource remote,
    required DeviceTokenStore tokenStore,
    required OAuthBrowser browser,
    Uri? callbackUrl,
    Uri? loginUrl,
  }) : this._(
         remote,
         tokenStore,
         browser,
         callbackUrl ?? Uri.parse(githubOAuthCallbackUrl),
         loginUrl ??
             Uri.parse(
               'https://overseer.rnm.dev/login?callback=${Uri.encodeComponent(callbackUrl?.toString() ?? githubOAuthCallbackUrl)}',
             ),
       );

  DefaultAuthRepository._(
    this._remote,
    this._tokenStore,
    this._browser,
    this._callbackUrl,
    this._loginUrl,
  );

  final AuthRemoteDataSource _remote;
  final DeviceTokenStore _tokenStore;
  final OAuthBrowser _browser;
  final Uri _callbackUrl;
  final Uri _loginUrl;

  @override
  Future<AuthSession?> restore() async {
    final token = await _tokenStore.read();
    if (token == null || token.isEmpty) return null;

    try {
      final user = await _remote.me(token);
      return AuthSession(token: token, user: user);
    } on RemoteAuthException catch (error) {
      if (error.statusCode == 401) {
        await _tokenStore.delete();
        return null;
      }
      rethrow;
    }
  }

  @override
  Future<AuthSession> signIn() async {
    final callback = await _browser.authenticate(_loginUrl, _callbackUrl);

    if (callback.scheme != _callbackUrl.scheme ||
        callback.host != _callbackUrl.host ||
        callback.path != _callbackUrl.path) {
      throw const AuthException('The sign-in callback was invalid.');
    }
    final providerError = callback.queryParameters['error'];
    if (providerError != null) {
      throw AuthException('GitHub sign-in failed: $providerError');
    }
    final code = callback.queryParameters['code'];
    final state = callback.queryParameters['state'];
    if (code == null || code.isEmpty) {
      throw const AuthException('GitHub did not return a sign-in code.');
    }
    if (state == null || state.isEmpty) {
      throw const AuthException('GitHub did not return a sign-in state.');
    }

    final session = await _remote.exchangeNativeSignIn(
      code: code,
      state: state,
    );
    await _tokenStore.write(session.token);
    return session;
  }

  @override
  Future<void> signOut() async {
    final token = await _tokenStore.read();
    if (token == null || token.isEmpty) return;
    try {
      await _remote.logout(token);
    } finally {
      await _tokenStore.delete();
    }
  }
}
