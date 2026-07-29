import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';

final overseerServerUrlProvider = Provider<Uri?>((ref) => null);

@immutable
class AppConfig {
  const AppConfig({required this.serverUrl, required this.oauthCallbackUrl});

  factory AppConfig.fromEnvironment() {
    return AppConfig.forFlavor(
      flavor: appFlavor,
      serverUrlOverride: const String.fromEnvironment('OVERSEER_URL'),
    );
  }

  factory AppConfig.forFlavor({
    required String? flavor,
    String serverUrlOverride = '',
  }) {
    final defaultUrl = switch (flavor) {
      'dev' => 'https://overseer-dev.rnm.dev',
      _ => 'https://overseer.rnm.dev',
    };
    final oauthCallbackScheme = flavor == 'dev' ? 'overseer-dev' : 'overseer';

    return AppConfig(
      serverUrl: Uri.parse(
        serverUrlOverride.isEmpty ? defaultUrl : serverUrlOverride,
      ),
      oauthCallbackUrl: Uri.parse('$oauthCallbackScheme://oauth/github'),
    );
  }

  AppConfig withServerUrl(Uri serverUrl) {
    return AppConfig(serverUrl: serverUrl, oauthCallbackUrl: oauthCallbackUrl);
  }

  final Uri serverUrl;
  final Uri oauthCallbackUrl;

  Uri get apiUrl => serverUrl.resolve('/api/');

  /// The single native-login entry point. The callback is kept in the query
  /// so the web client can preserve it through the GitHub round trip.
  Uri get nativeLoginUrl => serverUrl.replace(
    path: '/login',
    queryParameters: {'callback': oauthCallbackUrl.toString()},
  );
}
