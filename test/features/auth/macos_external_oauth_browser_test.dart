import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/auth/data/macos_external_oauth_browser.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';

void main() {
  final authorizationUrl = Uri.parse(
    'https://overseer-dev.rnm.dev/login?callback=overseer-dev%3A%2F%2Foauth%2Fgithub',
  );
  final callbackUrl = Uri.parse('overseer-dev://oauth/github');

  test('opens the default browser and returns the exact callback', () async {
    final platform = _FakeMacOSExternalOAuthPlatform();
    final browser = MacOSExternalOAuthBrowser(platform: platform);

    final authentication = browser.authenticate(authorizationUrl, callbackUrl);
    await Future<void>.delayed(Duration.zero);
    platform.callback(
      Uri.parse('overseer-dev://oauth/github?state=opaque&code=app-code'),
    );

    expect(
      await authentication,
      Uri.parse('overseer-dev://oauth/github?state=opaque&code=app-code'),
    );
    expect(platform.openedUrl, authorizationUrl);
    expect(platform.ended, isTrue);
  });

  test('rejects a callback with the wrong route', () async {
    final platform = _FakeMacOSExternalOAuthPlatform();
    final browser = MacOSExternalOAuthBrowser(platform: platform);

    final authentication = browser.authenticate(authorizationUrl, callbackUrl);
    await Future<void>.delayed(Duration.zero);
    platform.callback(
      Uri.parse('overseer-dev://wrong/github?state=opaque&code=app-code'),
    );

    await expectLater(
      authentication,
      throwsA(
        isA<AuthException>().having(
          (error) => error.message,
          'message',
          contains('callback was invalid'),
        ),
      ),
    );
    expect(platform.ended, isTrue);
  });

  test('reports a default-browser launch failure and ends listening', () async {
    final platform = _FakeMacOSExternalOAuthPlatform(opened: false);
    final browser = MacOSExternalOAuthBrowser(platform: platform);

    await expectLater(
      browser.authenticate(authorizationUrl, callbackUrl),
      throwsA(
        isA<AuthException>().having(
          (error) => error.message,
          'message',
          contains('default browser'),
        ),
      ),
    );
    expect(platform.ended, isTrue);
  });

  test('times out and ends listening when no callback arrives', () async {
    final platform = _FakeMacOSExternalOAuthPlatform();
    final browser = MacOSExternalOAuthBrowser(
      platform: platform,
      timeout: const Duration(microseconds: 1),
    );

    await expectLater(
      browser.authenticate(authorizationUrl, callbackUrl),
      throwsA(
        isA<AuthException>().having(
          (error) => error.message,
          'message',
          contains('timed out'),
        ),
      ),
    );
    expect(platform.ended, isTrue);
  });
}

class _FakeMacOSExternalOAuthPlatform implements MacOSExternalOAuthPlatform {
  _FakeMacOSExternalOAuthPlatform({this.opened = true});

  final bool opened;
  OAuthCallbackHandler? _onCallback;
  Uri? openedUrl;
  bool ended = false;

  @override
  Future<void> begin(OAuthCallbackHandler onCallback) async {
    _onCallback = onCallback;
  }

  @override
  Future<void> end() async {
    ended = true;
    _onCallback = null;
  }

  @override
  Future<bool> openExternal(Uri url) async {
    openedUrl = url;
    return opened;
  }

  void callback(Uri callback) => _onCallback!(callback);
}
