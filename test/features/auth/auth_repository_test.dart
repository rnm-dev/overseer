import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/security/device_token_store.dart';
import 'package:overseer_mobile/features/auth/data/auth_api.dart';
import 'package:overseer_mobile/features/auth/data/default_auth_repository.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';
import 'package:overseer_mobile/features/auth/domain/auth_repository.dart';
import 'package:overseer_mobile/features/auth/domain/oauth_browser.dart';

void main() {
  const user = OperatorIdentity(email: 'dev@example.com', githubLogin: 'dev');

  group('AuthRepository.signIn', () {
    test('exchanges the app code and persists the device token', () async {
      final remote = _FakeRemote();
      final store = _MemoryTokenStore();
      final browser = _FakeBrowser(
        Uri.parse('overseer://oauth/github?state=opaque&code=app-code'),
      );
      final repository = DefaultAuthRepository(
        remote: remote,
        tokenStore: store,
        browser: browser,
      );

      final session = await repository.signIn();

      expect(session.token, 'device.secret');
      expect(session.user.email, user.email);
      expect(remote.exchangedCode, 'app-code');
      expect(remote.exchangedState, 'opaque');
      expect(browser.callbackUrl, Uri.parse(githubOAuthCallbackUrl));
      expect(
        browser.authorizationUrl,
        Uri.parse(
          'https://overseer.rnm.dev/login?callback=overseer%3A%2F%2Foauth%2Fgithub',
        ),
      );
      expect(store.token, 'device.secret');
    });

    test('rejects a callback for a different route', () async {
      final repository = DefaultAuthRepository(
        remote: _FakeRemote(),
        tokenStore: _MemoryTokenStore(),
        browser: _FakeBrowser(
          Uri.parse('overseer://other/github?state=opaque&code=app-code'),
        ),
      );

      await expectLater(
        repository.signIn(),
        throwsA(
          isA<AuthException>().having(
            (error) => error.message,
            'message',
            contains('callback was invalid'),
          ),
        ),
      );
    });

    test('uses and validates the configured flavor callback', () async {
      final remote = _FakeRemote();
      final browser = _FakeBrowser(
        Uri.parse('overseer-dev://oauth/github?state=opaque&code=app-code'),
      );
      final repository = DefaultAuthRepository(
        remote: remote,
        tokenStore: _MemoryTokenStore(),
        browser: browser,
        callbackUrl: Uri.parse('overseer-dev://oauth/github'),
      );

      await repository.signIn();

      expect(browser.callbackUrl, Uri.parse('overseer-dev://oauth/github'));
    });

    test('requires state from the callback before exchange', () async {
      final remote = _FakeRemote();
      final repository = DefaultAuthRepository(
        remote: remote,
        tokenStore: _MemoryTokenStore(),
        browser: _FakeBrowser(
          Uri.parse('overseer://oauth/github?code=app-code'),
        ),
      );

      await expectLater(
        repository.signIn(),
        throwsA(
          isA<AuthException>().having(
            (error) => error.message,
            'message',
            contains('did not return a sign-in state'),
          ),
        ),
      );
      expect(remote.exchangedCode, isNull);
    });

    test('surfaces an OAuth provider error', () async {
      final repository = DefaultAuthRepository(
        remote: _FakeRemote(),
        tokenStore: _MemoryTokenStore(),
        browser: _FakeBrowser(
          Uri.parse('overseer://oauth/github?state=opaque&error=access_denied'),
        ),
      );

      await expectLater(
        repository.signIn(),
        throwsA(
          isA<AuthException>().having(
            (error) => error.message,
            'message',
            contains('access_denied'),
          ),
        ),
      );
    });
  });

  group('AuthRepository.restore', () {
    test('restores a validated token', () async {
      final repository = DefaultAuthRepository(
        remote: _FakeRemote(),
        tokenStore: _MemoryTokenStore('stored.token'),
        browser: _FakeBrowser(Uri()),
      );

      final session = await repository.restore();

      expect(session?.token, 'stored.token');
      expect(session?.user.email, user.email);
    });

    test('clears a token rejected with 401', () async {
      final store = _MemoryTokenStore('expired.token');
      final repository = DefaultAuthRepository(
        remote: _FakeRemote(meError: true),
        tokenStore: store,
        browser: _FakeBrowser(Uri()),
      );

      expect(await repository.restore(), isNull);
      expect(store.token, isNull);
    });
  });

  test('sign out revokes and clears the stored device token', () async {
    final store = _MemoryTokenStore('stored.token');
    final remote = _FakeRemote();
    final repository = DefaultAuthRepository(
      remote: remote,
      tokenStore: store,
      browser: _FakeBrowser(Uri()),
    );

    await repository.signOut();

    expect(store.token, isNull);
    expect(remote.loggedOutToken, 'stored.token');
  });
}

class _FakeRemote implements AuthRemoteDataSource {
  _FakeRemote({this.meError = false});

  final bool meError;
  String? exchangedCode;
  String? exchangedState;
  String? loggedOutToken;

  @override
  Future<AuthSession> exchangeNativeSignIn({
    required String code,
    required String state,
  }) async {
    exchangedCode = code;
    exchangedState = state;
    return const AuthSession(
      token: 'device.secret',
      user: OperatorIdentity(email: 'dev@example.com', githubLogin: 'dev'),
    );
  }

  @override
  Future<OperatorIdentity> me(String token) async {
    if (meError) {
      throw const RemoteAuthException(
        statusCode: 401,
        code: 'UNAUTHENTICATED',
        message: 'authentication required',
      );
    }
    return const OperatorIdentity(email: 'dev@example.com', githubLogin: 'dev');
  }

  @override
  Future<void> logout(String token) async => loggedOutToken = token;
}

class _MemoryTokenStore implements DeviceTokenStore {
  _MemoryTokenStore([this.token]);

  String? token;

  @override
  Future<void> delete() async => token = null;

  @override
  Future<String?> read() async => token;

  @override
  Future<void> write(String token) async => this.token = token;
}

class _FakeBrowser implements OAuthBrowser {
  _FakeBrowser(this.callback);

  final Uri callback;
  Uri? callbackUrl;
  Uri? authorizationUrl;

  @override
  Future<Uri> authenticate(Uri authorizationUrl, Uri callbackUrl) async {
    this.authorizationUrl = authorizationUrl;
    this.callbackUrl = callbackUrl;
    return callback;
  }
}
