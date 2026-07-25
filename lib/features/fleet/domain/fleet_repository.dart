import 'fleet_models.dart';

abstract interface class FleetRepository {
  Future<List<WorkspaceFleet>> loadFleet();
}

class FleetException implements Exception {
  const FleetException(this.message);

  final String message;

  @override
  String toString() => message;
}
