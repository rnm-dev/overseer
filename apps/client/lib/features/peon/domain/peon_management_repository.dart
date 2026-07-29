import 'peon_management_models.dart';
import 'peon_settings_models.dart';

enum ArmoryAction { install, update, uninstall, enable, disable }

abstract interface class PeonManagementRepository {
  Future<ArmoryInventory?> loadCachedArmory(PeonSettingsScope scope);
  Future<ArmoryInventory> fetchArmory(
    PeonSettingsScope scope, {
    bool refresh = false,
  });
  Future<List<CliUpdateItem>?> loadCachedCliUpdates(PeonSettingsScope scope);
  Future<List<CliUpdateItem>> fetchCliUpdates(
    PeonSettingsScope scope, {
    bool refresh = false,
  });
  Future<ArmoryOperation> mutateArmory(
    PeonSettingsScope scope,
    String packageId,
    ArmoryAction action,
  );
  Future<ArmoryOperation> fetchArmoryOperation(
    PeonSettingsScope scope,
    String operationId,
  );
  Future<void> startCliUpdate(PeonSettingsScope scope, CliProvider provider);
}

class PeonManagementException implements Exception {
  const PeonManagementException(this.message, {this.unsupported = false});

  final String message;
  final bool unsupported;

  @override
  String toString() => message;
}
