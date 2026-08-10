import 'fleet_models.dart';

abstract interface class FleetRepository {
  Future<List<WorkspaceFleet>> loadFleet();
}

abstract interface class CachedFleetRepository implements FleetRepository {
  Future<List<WorkspaceFleet>> loadCachedFleet();

  Stream<List<WorkspaceFleet>> watchFleet();

  Future<List<WorkspaceFleet>> refreshFleet();

  Future<void> applyPeonProjection({
    required String workspaceId,
    required int cursor,
    required Map<String, dynamic> projection,
  });
}

class FleetException implements Exception {
  const FleetException(this.message);

  final String message;

  @override
  String toString() => message;
}
