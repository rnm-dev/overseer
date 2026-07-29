import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/security/device_token_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
  });

  test('isolates tokens by Overseer URL', () async {
    final first = SecureDeviceTokenStore(
      serverUrl: Uri.parse('https://one.example'),
    );
    final second = SecureDeviceTokenStore(
      serverUrl: Uri.parse('https://two.example'),
    );

    await first.write('first.token');
    await second.write('second.token');

    expect(await first.read(), 'first.token');
    expect(await second.read(), 'second.token');
    await first.delete();
    expect(await first.read(), isNull);
    expect(await second.read(), 'second.token');
  });

  test('migrates the legacy token only for the legacy connection', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{
      SecureDeviceTokenStore.legacyTokenKey: 'legacy.token',
    });
    final legacyConnection = SecureDeviceTokenStore(
      serverUrl: Uri.parse('https://legacy.example'),
      migrateLegacyToken: true,
    );
    final newConnection = SecureDeviceTokenStore(
      serverUrl: Uri.parse('https://new.example'),
    );

    expect(await newConnection.read(), isNull);
    expect(await legacyConnection.read(), 'legacy.token');
    expect(
      await const FlutterSecureStorage().read(
        key: SecureDeviceTokenStore.legacyTokenKey,
      ),
      isNull,
    );
    expect(await legacyConnection.read(), 'legacy.token');
  });
}
