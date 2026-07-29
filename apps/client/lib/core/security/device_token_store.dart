import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:overseer_mobile/core/config/overseer_connection_store.dart';

abstract interface class DeviceTokenStore {
  Future<String?> read();

  Future<void> write(String token);

  Future<void> delete();
}

class SecureDeviceTokenStore implements DeviceTokenStore {
  SecureDeviceTokenStore({
    required Uri serverUrl,
    this.migrateLegacyToken = false,
    FlutterSecureStorage? storage,
  }) : _tokenKey =
           'overseer_device_token.${overseerConnectionStorageId(serverUrl)}',
       _storage =
           storage ??
           const FlutterSecureStorage(
             iOptions: IOSOptions(
               accessibility: KeychainAccessibility.first_unlock_this_device,
             ),
           );

  static const legacyTokenKey = 'overseer_device_token';

  final String _tokenKey;
  final bool migrateLegacyToken;
  final FlutterSecureStorage _storage;

  @override
  Future<String?> read() async {
    final token = await _storage.read(key: _tokenKey);
    if (token != null || !migrateLegacyToken) return token;

    final legacyToken = await _storage.read(key: legacyTokenKey);
    if (legacyToken == null) return null;
    await _storage.write(key: _tokenKey, value: legacyToken);
    await _storage.delete(key: legacyTokenKey);
    return legacyToken;
  }

  @override
  Future<void> write(String token) =>
      _storage.write(key: _tokenKey, value: token);

  @override
  Future<void> delete() => _storage.delete(key: _tokenKey);
}
