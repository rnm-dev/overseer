import 'dart:async';

import 'package:flutter/services.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';
import 'package:overseer_mobile/features/auth/domain/oauth_browser.dart';
import 'package:url_launcher/url_launcher.dart';

typedef OAuthCallbackHandler = void Function(Uri callback);

class MacOSExternalOAuthBrowser implements OAuthBrowser {
  MacOSExternalOAuthBrowser({
    MacOSExternalOAuthPlatform? platform,
    this.timeout = const Duration(minutes: 5),
  }) : _platform = platform ?? const PluginMacOSExternalOAuthPlatform(),
       assert(timeout > Duration.zero);

  final MacOSExternalOAuthPlatform _platform;
  final Duration timeout;

  @override
  Future<Uri> authenticate(Uri authorizationUrl, Uri callbackUrl) async {
    final result = Completer<Uri>();
    await _platform.begin((callback) {
      if (result.isCompleted) return;
      if (!_matchesCallback(callback, callbackUrl)) {
        result.completeError(
          const AuthException('The sign-in callback was invalid.'),
        );
        return;
      }
      result.complete(callback);
    });

    try {
      if (!await _platform.openExternal(authorizationUrl)) {
        throw const AuthException('The default browser could not be opened.');
      }
      return await result.future.timeout(
        timeout,
        onTimeout: () =>
            throw const AuthException('Sign-in timed out. Please try again.'),
      );
    } on PlatformException {
      throw const AuthException('The default browser could not be opened.');
    } finally {
      await _platform.end();
    }
  }

  bool _matchesCallback(Uri actual, Uri expected) {
    return actual.scheme == expected.scheme &&
        actual.host == expected.host &&
        actual.path == expected.path;
  }
}

abstract interface class MacOSExternalOAuthPlatform {
  Future<void> begin(OAuthCallbackHandler onCallback);

  Future<bool> openExternal(Uri url);

  Future<void> end();
}

class PluginMacOSExternalOAuthPlatform implements MacOSExternalOAuthPlatform {
  const PluginMacOSExternalOAuthPlatform();

  static const _channel = MethodChannel('org.ovrseer.app/oauth');

  @override
  Future<void> begin(OAuthCallbackHandler onCallback) async {
    _channel.setMethodCallHandler((call) async {
      if (call.method != 'oauthCallback' || call.arguments is! String) return;
      final callback = Uri.tryParse(call.arguments as String);
      if (callback != null) onCallback(callback);
    });
    await _channel.invokeMethod<void>('beginOAuth');
  }

  @override
  Future<bool> openExternal(Uri url) {
    return launchUrl(url, mode: LaunchMode.externalApplication);
  }

  @override
  Future<void> end() async {
    try {
      await _channel.invokeMethod<void>('endOAuth');
    } finally {
      _channel.setMethodCallHandler(null);
    }
  }
}
