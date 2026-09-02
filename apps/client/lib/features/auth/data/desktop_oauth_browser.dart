import 'dart:async';
import 'dart:io';

import 'package:desktop_webview_window/desktop_webview_window.dart';
import 'package:flutter/services.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';
import 'package:overseer_mobile/features/auth/domain/oauth_browser.dart';

class DesktopOAuthBrowser implements OAuthBrowser {
  DesktopOAuthBrowser({DesktopOAuthWindowFactory? windowFactory})
    : _windowFactory = windowFactory ?? const PluginDesktopOAuthWindowFactory();

  static const _timeout = Duration(minutes: 5);

  final DesktopOAuthWindowFactory _windowFactory;
  DesktopOAuthWindow? _activeWindow;

  @override
  Future<Uri> authenticate(Uri authorizationUrl, Uri callbackUrl) async {
    if (!await _windowFactory.isAvailable()) {
      throw const AuthException(
        'The secure sign-in WebView is not available on this computer.',
      );
    }

    _activeWindow?.close();
    final window = await _windowFactory.create();
    _activeWindow = window;
    final result = Completer<Uri>();

    window.setUrlRequestHandler((url) {
      final uri = Uri.tryParse(url);
      if (uri == null || uri.scheme != callbackUrl.scheme) return true;

      if (!result.isCompleted) {
        if (_matchesCallback(uri, callbackUrl)) {
          result.complete(uri);
        } else {
          result.completeError(
            const AuthException('The sign-in callback was invalid.'),
          );
        }
      }
      window.close();

      // The callback is a message to the app, not a page to render. Blocking
      // this navigation prevents WebView2/WebKitGTK from showing an error page.
      return false;
    });

    unawaited(
      window.onClose.whenComplete(() {
        if (!result.isCompleted) {
          result.completeError(const AuthException('Sign-in was canceled.'));
        }
      }),
    );

    window.launch(authorizationUrl);
    try {
      return await result.future.timeout(
        _timeout,
        onTimeout: () {
          window.close();
          throw const AuthException('Sign-in timed out. Please try again.');
        },
      );
    } on PlatformException {
      throw const AuthException(
        'The secure sign-in WebView could not be opened.',
      );
    } finally {
      if (identical(_activeWindow, window)) _activeWindow = null;
    }
  }

  bool _matchesCallback(Uri actual, Uri expected) {
    return actual.scheme == expected.scheme &&
        actual.host == expected.host &&
        actual.path == expected.path;
  }
}

abstract interface class DesktopOAuthWindowFactory {
  Future<bool> isAvailable();

  Future<DesktopOAuthWindow> create();
}

abstract interface class DesktopOAuthWindow {
  Future<void> get onClose;

  void setUrlRequestHandler(bool Function(String url) handler);

  void launch(Uri url);

  void close();
}

class PluginDesktopOAuthWindowFactory implements DesktopOAuthWindowFactory {
  const PluginDesktopOAuthWindowFactory();

  @override
  Future<bool> isAvailable() => WebviewWindow.isWebviewAvailable();

  @override
  Future<DesktopOAuthWindow> create() async {
    final userDataFolder = Directory.systemTemp.uri
        .resolve('overseer-oauth-webview/')
        .toFilePath();
    final webview = await WebviewWindow.create(
      configuration: CreateConfiguration(
        windowHeight: 720,
        windowWidth: 960,
        title: 'Sign in to GitHub',
        userDataFolderWindows: userDataFolder,
      ),
    );
    return PluginDesktopOAuthWindow(webview);
  }
}

class PluginDesktopOAuthWindow implements DesktopOAuthWindow {
  PluginDesktopOAuthWindow(this._webview);

  final Webview _webview;

  @override
  Future<void> get onClose => _webview.onClose;

  @override
  void setUrlRequestHandler(bool Function(String url) handler) {
    _webview.setOnUrlRequestCallback(handler);
  }

  @override
  void launch(Uri url) => _webview.launch(
    url.toString(),
    // The initial URL is app-owned and already trusted. Let WebView2 load it
    // directly; the plugin re-enables request interception after this first
    // navigation so the custom-scheme OAuth callback is still caught below.
    triggerOnUrlRequestEvent: false,
  );

  @override
  void close() => _webview.close();
}
