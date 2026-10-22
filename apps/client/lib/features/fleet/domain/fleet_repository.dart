import 'fleet_models.dart';

/// Cache-first fleet source: the cached snapshot is served immediately and
/// [watchFleet] emits whenever a refresh or live projection updates it.
abstract interface class FleetRepository {
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
