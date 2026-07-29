import 'package:flutter/services.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';
import 'package:overseer_mobile/features/auth/domain/oauth_browser.dart';

class SystemOAuthBrowser implements OAuthBrowser {
  const SystemOAuthBrowser();

  @override
  Future<Uri> authenticate(Uri authorizationUrl, Uri callbackUrl) async {
    try {
      final result = await FlutterWebAuth2.authenticate(
        url: authorizationUrl.toString(),
        callbackUrlScheme: callbackUrl.scheme,
        options: FlutterWebAuth2Options(
          httpsHost: callbackUrl.host,
          httpsPath: callbackUrl.path,
        ),
      );
      return Uri.parse(result);
    } on PlatformException catch (error) {
      final code = error.code.toUpperCase();
      if (code == 'CANCELED' || code == 'CANCELLED') {
        throw const AuthException('Sign-in was canceled.');
      }
      throw const AuthException(
        'The secure sign-in browser could not be opened.',
      );
    }
  }
}
