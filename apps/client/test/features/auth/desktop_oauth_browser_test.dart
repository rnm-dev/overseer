import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/auth/data/desktop_oauth_browser.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';

void main() {
  final authorizationUrl = Uri.parse(
    'https://github.com/login/oauth/authorize',
  );
  final callbackUrl = Uri.parse('overseer://oauth/github');

  test('intercepts the exact callback, closes, and returns it', () async {
    final window = _FakeWindow();
    final browser = DesktopOAuthBrowser(
      windowFactory: _FakeWindowFactory(window),
    );

    final authentication = browser.authenticate(authorizationUrl, callbackUrl);
    await Future<void>.delayed(Duration.zero);
    final allowNavigation = window.request(
      'overseer://oauth/github?state=opaque&code=app-code',
    );

    expect(allowNavigation, isFalse);
    expect(window.closed, isTrue);
    expect(
      await authentication,
      Uri.parse('overseer://oauth/github?state=opaque&code=app-code'),
    );
  });

  test('blocks and rejects a callback with the wrong route', () async {
    final window = _FakeWindow();
    final browser = DesktopOAuthBrowser(
      windowFactory: _FakeWindowFactory(window),
    );

    final authentication = browser.authenticate(authorizationUrl, callbackUrl);
    await Future<void>.delayed(Duration.zero);
    final allowNavigation = window.request(
      'overseer://wrong/github?state=opaque&code=app-code',
    );

    expect(allowNavigation, isFalse);
    expect(window.closed, isTrue);
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
  });

  test('allows ordinary GitHub navigation', () async {
    final window = _FakeWindow();
    final browser = DesktopOAuthBrowser(
      windowFactory: _FakeWindowFactory(window),
    );

    final authentication = browser.authenticate(authorizationUrl, callbackUrl);
    await Future<void>.delayed(Duration.zero);

    expect(window.request('https://github.com/login'), isTrue);
    expect(window.closed, isFalse);

    window.close();
    await expectLater(authentication, throwsA(isA<AuthException>()));
  });
}

class _FakeWindowFactory implements DesktopOAuthWindowFactory {
  _FakeWindowFactory(this.window);

  final _FakeWindow window;

  @override
  Future<DesktopOAuthWindow> create() async => window;

  @override
  Future<bool> isAvailable() async => true;
}

class _FakeWindow implements DesktopOAuthWindow {
  final _closed = Completer<void>();
  bool Function(String url)? _handler;
  bool closed = false;

  bool request(String url) => _handler!(url);

  @override
  Future<void> get onClose => _closed.future;

  @override
  void close() {
    closed = true;
    if (!_closed.isCompleted) _closed.complete();
  }

  @override
  void launch(Uri url) {}

  @override
  void setUrlRequestHandler(bool Function(String url) handler) {
    _handler = handler;
  }
}
