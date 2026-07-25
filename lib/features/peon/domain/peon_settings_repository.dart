import 'peon_settings_models.dart';
import '../../sessions/domain/followup_repository.dart';

abstract interface class PeonSettingsRepository {
  Future<PeonSettings> fetchSettings(PeonSettingsScope scope);
  Future<PeonStatus?> fetchStatus(PeonSettingsScope scope);
  Future<ModelsCatalog?> fetchModelCatalog(PeonSettingsScope scope);
  Future<PeonSettings> updateSettings(
    PeonSettingsScope scope,
    Map<String, dynamic> patch,
  );
  Future<void> updateConnection(PeonSettingsScope scope, String publicUrl);
  Future<PeonStatus> checkForUpdate(PeonSettingsScope scope);
  Future<void> installUpdate(PeonSettingsScope scope);
  Future<void> deletePeon(PeonSettingsScope scope);
}

class PeonSettingsException implements Exception {
  const PeonSettingsException(this.message, {this.unsupported = false});

  final String message;
  final bool unsupported;

  @override
  String toString() => message;
}
