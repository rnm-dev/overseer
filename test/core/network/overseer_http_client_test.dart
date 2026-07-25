import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/network/overseer_http_client.dart';

void main() {
  test('configures the authenticated Overseer REST client', () {
    final dio = createOverseerHttpClient(
      apiUrl: Uri.parse('https://overseer.example/api/'),
      token: 'auth-token',
    );
    addTearDown(() => dio.close(force: true));

    expect(dio.options.baseUrl, 'https://overseer.example/api/');
    expect(dio.options.connectTimeout, overseerHttpConnectTimeout);
    expect(dio.options.receiveTimeout, overseerHttpReceiveTimeout);
    expect(dio.options.headers['Accept'], 'application/json');
    expect(dio.options.headers['Authorization'], 'Bearer auth-token');
  });
}
