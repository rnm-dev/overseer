import 'package:dio/dio.dart';

import '../../../core/network/overseer_http_client.dart';
import '../domain/fleet_models.dart';
import '../domain/fleet_repository.dart';

class DioFleetRepository implements FleetRepository {
  DioFleetRepository({required Uri apiUrl, required String token, Dio? dio})
    : _dio = dio ?? createOverseerHttpClient(apiUrl: apiUrl, token: token);

  final Dio _dio;

  @override
  Future<List<WorkspaceFleet>> loadFleet() async {
    try {
      final workspaceResponse = await _dio.get<Map<String, dynamic>>(
        'workspaces',
      );
      final workspaceJson = _list(workspaceResponse.data, 'workspaces');
      final workspaces = workspaceJson.map(_workspaceFromJson).toList();
      final peonLists = await Future.wait(
        workspaces.map((workspace) async {
          final response = await _dio.get<Map<String, dynamic>>(
            'workspaces/${Uri.encodeComponent(workspace.id)}/peons',
          );
          return _list(response.data, 'peons').map(_peonFromJson).toList();
        }),
      );

      return [
        for (var index = 0; index < workspaces.length; index++)
          WorkspaceFleet(workspace: workspaces[index], peons: peonLists[index]),
      ];
    } on DioException catch (error) {
      final payload = error.response?.data;
      final serverMessage = payload is Map<String, dynamic>
          ? payload['error'] as String?
          : null;
      throw FleetException(
        serverMessage ??
            'Could not reach Overseer. Check your connection and try again.',
      );
    } on FormatException catch (error) {
      throw FleetException(error.message);
    } on TypeError {
      throw const FleetException(
        'Overseer returned an invalid fleet response.',
      );
    }
  }

  List<Map<String, dynamic>> _list(Map<String, dynamic>? payload, String key) {
    final value = payload?[key];
    if (value is! List) {
      throw FleetException('Overseer returned an invalid $key response.');
    }
    return value.cast<Map<String, dynamic>>();
  }

  Workspace _workspaceFromJson(Map<String, dynamic> json) {
    return Workspace(
      id: json['id'] as String,
      name: json['name'] as String,
      role: json['role'] as String?,
    );
  }

  Peon _peonFromJson(Map<String, dynamic> json) {
    final loadJson = json['load'];
    return Peon(
      id: json['peonId'] as String,
      name: json['name'] as String?,
      hostname: json['hostname'] as String?,
      baseUrl: json['baseUrl'] as String?,
      addressSource: json['addressSource'] as String?,
      online: json['online'] as bool? ?? false,
      lastSeen: (json['lastSeen'] as num?)?.toDouble() ?? 0,
      capabilities:
          (json['capabilities'] as List?)?.whereType<String>().toList() ??
          const [],
      load: loadJson is Map<String, dynamic>
          ? PeonLoad(
              activeSessions: (loadJson['activeSessions'] as num?)?.toInt(),
              paused: loadJson['paused'] as bool?,
            )
          : null,
    );
  }
}
