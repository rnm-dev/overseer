import 'package:overseer_mobile/core/config/overseer_connection_store.dart';
import 'package:overseer_mobile/core/security/device_token_store.dart';

abstract interface class ConnectionCredentialCleaner {
  Future<void> delete(OverseerConnection connection);
}

class SecureConnectionCredentialCleaner implements ConnectionCredentialCleaner {
  const SecureConnectionCredentialCleaner();

  @override
  Future<void> delete(OverseerConnection connection) async {
    await SecureDeviceTokenStore(serverUrl: connection.serverUrl).delete();
  }
}
