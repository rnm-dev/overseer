import 'package:dio/dio.dart';

import '../../../core/network/overseer_http_client.dart';
import '../../sessions/domain/followup_repository.dart';
import '../domain/peon_settings_models.dart';
import '../domain/peon_settings_repository.dart';

class DioPeonSettingsRepository implements PeonSettingsRepository {
  DioPeonSettingsRepository({
    required Uri apiUrl,
    required String token,
    Dio? dio,
  }) : _dio = dio ?? createOverseerHttpClient(apiUrl: apiUrl, token: token);

  final Dio _dio;

  String _root(PeonSettingsScope scope) =>
      'workspaces/${Uri.encodeComponent(scope.workspaceId)}/peons/'
      '${Uri.encodeComponent(scope.peonId)}';

  @override
  Future<PeonSettings> fetchSettings(PeonSettingsScope scope) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '${_root(scope)}/settings',
      );
      return PeonSettings.fromJson(_payload(response));
    } on DioException catch (error) {
      throw _exception(
        error,
        'Could not load Peon settings.',
        unsupported: error.response?.statusCode == 404,
      );
    } on Object catch (error) {
      if (error is PeonSettingsException) rethrow;
      throw const PeonSettingsException(
        'Overseer returned invalid Peon settings.',
      );
    }
  }

  @override
  Future<PeonStatus?> fetchStatus(PeonSettingsScope scope) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '${_root(scope)}/status',
      );
      return PeonStatus.fromJson(_payload(response));
    } on DioException {
      return null;
    } on Object {
      return null;
    }
  }

  @override
  Future<ModelsCatalog?> fetchModelCatalog(PeonSettingsScope scope) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '${_root(scope)}/models',
      );
      final data = _payload(response);
      final providers = data['providers'];
      if (providers is! List) return null;
      return ModelsCatalog(
        providers: providers
            .whereType<Map>()
            .map((raw) => Map<String, dynamic>.from(raw))
            .map(
              (raw) => ModelProvider(
                agent: raw['agent'] as String? ?? '',
                label: raw['label'] as String? ?? raw['agent'] as String? ?? '',
                models: _options(raw['models']),
                reasoningEfforts: _options(raw['reasoningEfforts']),
              ),
            )
            .where((provider) => provider.agent.isNotEmpty)
            .toList(growable: false),
        defaultModel: data['defaultModel'] as String?,
        defaultAgent: data['defaultAgent'] as String?,
      );
    } on Object {
      return null;
    }
  }

  @override
  Future<PeonSettings> updateSettings(
    PeonSettingsScope scope,
    Map<String, dynamic> patch,
  ) async {
    try {
      final response = await _dio.patch<Map<String, dynamic>>(
        '${_root(scope)}/settings',
        data: patch,
      );
      return PeonSettings.fromJson(_payload(response));
    } on DioException catch (error) {
      throw _exception(error, 'Could not save Peon settings.');
    } on Object catch (error) {
      if (error is PeonSettingsException) rethrow;
      throw const PeonSettingsException(
        'Overseer returned invalid Peon settings.',
      );
    }
  }

  @override
  Future<void> updateConnection(
    PeonSettingsScope scope,
    String publicUrl,
  ) async {
    try {
      await _dio.patch<Map<String, dynamic>>(
        _root(scope),
        data: {'publicUrl': publicUrl},
      );
    } on DioException catch (error) {
      throw _exception(error, 'Could not save the Peon address.');
    }
  }

  @override
  Future<PeonStatus> checkForUpdate(PeonSettingsScope scope) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '${_root(scope)}/control/check-update',
      );
      return PeonStatus.fromJson(_payload(response));
    } on DioException catch (error) {
      throw _exception(error, 'Could not check for a Peon update.');
    } on Object catch (error) {
      if (error is PeonSettingsException) rethrow;
      throw const PeonSettingsException(
        'Overseer returned an invalid Peon update status.',
      );
    }
  }

  @override
  Future<void> installUpdate(PeonSettingsScope scope) async {
    try {
      await _dio.post<void>('${_root(scope)}/control/update');
    } on DioException catch (error) {
      throw _exception(error, 'Could not install the Peon update.');
    }
  }

  @override
  Future<void> deletePeon(PeonSettingsScope scope) async {
    try {
      await _dio.delete<void>(_root(scope));
    } on DioException catch (error) {
      throw _exception(error, 'Could not remove this Peon.');
    }
  }

  Map<String, dynamic> _payload(Response<Map<String, dynamic>> response) {
    final data = response.data;
    if (data == null) throw const FormatException('Empty response');
    return data;
  }

  List<ModelCatalogOption> _options(Object? value) => value is! List
      ? const []
      : value
            .whereType<Map>()
            .map((raw) => Map<String, dynamic>.from(raw))
            .map(
              (raw) => ModelCatalogOption(
                id: raw['id'] as String? ?? '',
                label: raw['label'] as String? ?? raw['id'] as String? ?? '',
                alias: raw['alias'] as String?,
                isDefault: raw['default'] as bool? ?? false,
              ),
            )
            .where((option) => option.id.isNotEmpty)
            .toList(growable: false);

  PeonSettingsException _exception(
    DioException error,
    String fallback, {
    bool unsupported = false,
  }) {
    final payload = error.response?.data;
    final serverMessage = payload is Map ? payload['error']?.toString() : null;
    return PeonSettingsException(
      serverMessage ?? fallback,
      unsupported: unsupported,
    );
  }
}
