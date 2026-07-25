import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/config/app_config.dart';

void main() {
  group('AppConfig', () {
    test('uses the development deployment for the dev flavor', () {
      final config = AppConfig.forFlavor(flavor: 'dev');

      expect(config.serverUrl, Uri.parse('https://overseer-dev.rnm.dev'));
      expect(config.apiUrl, Uri.parse('https://overseer-dev.rnm.dev/api/'));
      expect(config.oauthCallbackUrl, Uri.parse('overseer-dev://oauth/github'));
      expect(
        config.nativeLoginUrl,
        Uri.parse(
          'https://overseer-dev.rnm.dev/login?callback=overseer-dev%3A%2F%2Foauth%2Fgithub',
        ),
      );
    });

    test('uses the production deployment for the prod flavor', () {
      final config = AppConfig.forFlavor(flavor: 'prod');

      expect(config.serverUrl, Uri.parse('https://overseer.rnm.dev'));
      expect(config.oauthCallbackUrl, Uri.parse('overseer://oauth/github'));
      expect(
        config.nativeLoginUrl,
        Uri.parse(
          'https://overseer.rnm.dev/login?callback=overseer%3A%2F%2Foauth%2Fgithub',
        ),
      );
    });

    test('keeps production as the safe default without a flavor', () {
      final config = AppConfig.forFlavor(flavor: null);

      expect(config.serverUrl, Uri.parse('https://overseer.rnm.dev'));
    });

    test('allows an explicit server URL to override the flavor', () {
      final config = AppConfig.forFlavor(
        flavor: 'dev',
        serverUrlOverride: 'https://overseer.example',
      );

      expect(config.serverUrl, Uri.parse('https://overseer.example'));
    });

    test('keeps the flavor callback when applying a remembered server', () {
      final config = AppConfig.forFlavor(
        flavor: 'dev',
      ).withServerUrl(Uri.parse('https://self-hosted.example'));

      expect(config.serverUrl, Uri.parse('https://self-hosted.example'));
      expect(config.apiUrl, Uri.parse('https://self-hosted.example/api/'));
      expect(config.oauthCallbackUrl, Uri.parse('overseer-dev://oauth/github'));
      expect(
        config.nativeLoginUrl,
        Uri.parse(
          'https://self-hosted.example/login?callback=overseer-dev%3A%2F%2Foauth%2Fgithub',
        ),
      );
    });
  });
}
