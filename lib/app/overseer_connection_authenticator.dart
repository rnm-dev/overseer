import 'package:flutter/foundation.dart';
import 'package:overseer_mobile/core/config/app_config.dart';
import 'package:overseer_mobile/core/config/overseer_connection_store.dart';
import 'package:overseer_mobile/core/security/device_token_store.dart';
import 'package:overseer_mobile/features/auth/data/auth_api.dart';
import 'package:overseer_mobile/features/auth/data/default_auth_repository.dart';
import 'package:overseer_mobile/features/auth/data/desktop_oauth_browser.dart';
import 'package:overseer_mobile/features/auth/data/system_oauth_browser.dart';
import 'package:overseer_mobile/features/auth/domain/auth_repository.dart';

typedef OverseerConnectionAuthenticator =
    Future<void> Function(AppConfig config, OverseerConnection connection);

AuthRepository createOverseerAuthRepository({
  required AppConfig config,
  required OverseerConnection connection,
}) {
  final useEmbeddedDesktopOAuth =
      defaultTargetPlatform == TargetPlatform.windows ||
      defaultTargetPlatform == TargetPlatform.linux;
  return DefaultAuthRepository(
    remote: DioAuthRemoteDataSource(apiUrl: config.apiUrl),
    tokenStore: SecureDeviceTokenStore(
      serverUrl: connection.serverUrl,
      migrateLegacyToken: connection.usesLegacyStorage,
    ),
    browser: useEmbeddedDesktopOAuth
        ? DesktopOAuthBrowser()
        : const SystemOAuthBrowser(),
    callbackUrl: config.oauthCallbackUrl,
    loginUrl: config.nativeLoginUrl,
  );
}

Future<void> authenticateOverseerConnection(
  AppConfig config,
  OverseerConnection connection,
) async {
  final repository = createOverseerAuthRepository(
    config: config,
    connection: connection,
  );
  final restoredSession = await repository.restore();
  if (restoredSession == null) {
    await repository.signIn();
  }
}
