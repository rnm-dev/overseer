import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:drift/drift.dart';

import '../../../core/database/app_database.dart';
import '../../../core/network/overseer_http_client.dart';
import '../../../core/time/app_time.dart';
import '../domain/peon_management_models.dart';
import '../domain/peon_management_repository.dart';
import '../domain/peon_settings_models.dart';

class DioPeonManagementRepository implements PeonManagementRepository {
  DioPeonManagementRepository({
    required this.database,
    required Uri apiUrl,
    required String token,
    Dio? dio,
    this._clock = const SystemAppClock(),
  }) : _dio = dio ?? createOverseerHttpClient(apiUrl: apiUrl, token: token);

  final AppDatabase database;
  final Dio _dio;
  final AppClock _clock;

  String _root(PeonSettingsScope scope) =>
      'workspaces/${Uri.encodeComponent(scope.workspaceId)}/peons/'
      '${Uri.encodeComponent(scope.peonId)}';

  @override
  Future<ArmoryInventory?> loadCachedArmory(PeonSettingsScope scope) async {
    final payload = await _cached(scope, 'armory');
    if (payload == null) return null;
    try {
      return ArmoryInventory.fromJson(payload);
    } on Object {
      return null;
    }
  }

  @override
  Future<ArmoryInventory> fetchArmory(
    PeonSettingsScope scope, {
    bool refresh = false,
  }) async {
    try {
      if (refresh) {
        await _dio.post<void>('${_root(scope)}/armory/refresh');
      }
      final packages = <ArmoryPackage>[];
      late ArmoryInventory page;
      String? cursor;
      do {
        final response = await _dio.get<Map<String, dynamic>>(
          '${_root(scope)}/armory/packages',
          queryParameters: {'limit': 100, 'cursor': ?cursor},
        );
        final payload = _payload(response);
        page = ArmoryInventory.fromJson(payload);
        packages.addAll(page.packages);
        cursor = payload['nextCursor'] as String?;
      } while (cursor != null && cursor.isNotEmpty);
      final inventory = ArmoryInventory(
        registry: page.registry,
        packages: packages,
        total: page.total,
        cachedAt: _clock.now().millisecondsSinceEpoch.toDouble(),
      );
      await _cache(scope, 'armory', inventory.toJson());
      return inventory;
    } on DioException catch (error) {
      throw _exception(
        error,
        'Could not load Armory packages.',
        unsupported: error.response?.statusCode == 404,
      );
    } on PeonManagementException {
      rethrow;
    } on Object {
      throw const PeonManagementException(
        'Overseer returned invalid Armory data.',
      );
    }
  }

  @override
  Future<List<CliUpdateItem>?> loadCachedCliUpdates(
    PeonSettingsScope scope,
  ) async {
    final payload = await _cached(scope, 'cli-updates');
    if (payload == null) return null;
    try {
      return (payload['items'] as List? ?? const [])
          .whereType<Map>()
          .map(
            (value) => CliUpdateItem.fromJson(Map<String, dynamic>.from(value)),
          )
          .toList(growable: false);
    } on Object {
      return null;
    }
  }

  @override
  Future<List<CliUpdateItem>> fetchCliUpdates(
    PeonSettingsScope scope, {
    bool refresh = false,
  }) async {
    try {
      final response = await _dio.get<Object>(
        '${_root(scope)}/ai/cli-updates',
        queryParameters: refresh ? {'refresh': 'true'} : null,
      );
      final items = _normalizeCli(response.data);
      await _cache(scope, 'cli-updates', {
        'items': items.map((item) => item.toJson()).toList(growable: false),
      });
      return items;
    } on DioException catch (error) {
      throw _exception(
        error,
        'Could not load provider updates.',
        unsupported: error.response?.statusCode == 404,
      );
    } on PeonManagementException {
      rethrow;
    } on Object {
      throw const PeonManagementException(
        'Overseer returned invalid provider update data.',
      );
    }
  }

  @override
  Future<ArmoryOperation> mutateArmory(
    PeonSettingsScope scope,
    String packageId,
    ArmoryAction action,
  ) async {
    final package = Uri.encodeComponent(packageId);
    final root = '${_root(scope)}/armory/packages/$package';
    final path = switch (action) {
      ArmoryAction.install => '$root/install',
      ArmoryAction.update => '$root/update',
      ArmoryAction.uninstall => root,
      ArmoryAction.enable => '$root/enable',
      ArmoryAction.disable => '$root/disable',
    };
    try {
      final response = action == ArmoryAction.uninstall
          ? await _dio.delete<Map<String, dynamic>>(path, data: const {})
          : await _dio.post<Map<String, dynamic>>(path, data: const {});
      return _operation(response);
    } on DioException catch (error) {
      throw _exception(error, 'Could not ${action.name} this package.');
    }
  }

  @override
  Future<ArmoryOperation> fetchArmoryOperation(
    PeonSettingsScope scope,
    String operationId,
  ) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '${_root(scope)}/armory/operations/'
        '${Uri.encodeComponent(operationId)}',
      );
      return _operation(response);
    } on DioException catch (error) {
      throw _exception(error, 'Could not check the package operation.');
    }
  }

  @override
  Future<void> startCliUpdate(
    PeonSettingsScope scope,
    CliProvider provider,
  ) async {
    try {
      await _dio.post<void>(
        '${_root(scope)}/ai/cli-updates/'
        '${Uri.encodeComponent(provider.apiValue)}',
        data: const {},
      );
    } on DioException catch (error) {
      throw _exception(error, 'Could not start the provider update.');
    }
  }

  ArmoryOperation _operation(Response<Map<String, dynamic>> response) {
    final operation = _payload(response)['operation'];
    if (operation is! Map) {
      throw const PeonManagementException(
        'Overseer returned an invalid package operation.',
      );
    }
    return ArmoryOperation.fromJson(Map<String, dynamic>.from(operation));
  }

  Future<Map<String, dynamic>?> _cached(
    PeonSettingsScope scope,
    String kind,
  ) async {
    final row =
        await (database.select(database.cachedPeonManagement)..where(
              (row) =>
                  row.workspaceId.equals(scope.workspaceId) &
                  row.peonId.equals(scope.peonId) &
                  row.kind.equals(kind),
            ))
            .getSingleOrNull();
    if (row == null) return null;
    final decoded = jsonDecode(row.payloadJson);
    return decoded is Map ? Map<String, dynamic>.from(decoded) : null;
  }

  Future<void> _cache(
    PeonSettingsScope scope,
    String kind,
    Map<String, dynamic> payload,
  ) => database
      .into(database.cachedPeonManagement)
      .insertOnConflictUpdate(
        CachedPeonManagementCompanion.insert(
          workspaceId: scope.workspaceId,
          peonId: scope.peonId,
          kind: kind,
          payloadJson: jsonEncode(payload),
          updatedAt: _clock.now().millisecondsSinceEpoch.toDouble(),
        ),
      );

  Map<String, dynamic> _payload(Response<Map<String, dynamic>> response) {
    final data = response.data;
    if (data == null) throw const FormatException('Empty response');
    return data;
  }

  PeonManagementException _exception(
    DioException error,
    String fallback, {
    bool unsupported = false,
  }) {
    final payload = error.response?.data;
    final serverMessage = payload is Map ? payload['error']?.toString() : null;
    return PeonManagementException(
      serverMessage ?? fallback,
      unsupported: unsupported,
    );
  }
}

List<CliUpdateItem> _normalizeCli(Object? raw) {
  final entries = <({CliProvider? hint, Map<String, dynamic> value})>[];
  void collect(Object? value) {
    if (value is List) {
      for (final item in value) {
        if (item is Map) {
          entries.add((hint: null, value: Map<String, dynamic>.from(item)));
        }
      }
      return;
    }
    if (value is! Map) return;
    final map = Map<String, dynamic>.from(value);
    for (final key in ['tools', 'providers', 'updates', 'items', 'agents']) {
      final nested = map[key];
      if (nested is List) {
        collect(nested);
        return;
      }
      if (nested is Map) {
        final values = Map<String, dynamic>.from(nested);
        for (final provider in CliProvider.values) {
          final candidate = provider == CliProvider.claudeCode
              ? values['claude-code'] ??
                    values['claudeCode'] ??
                    values['claude']
              : values['codex'];
          if (candidate is Map) {
            entries.add((
              hint: provider,
              value: Map<String, dynamic>.from(candidate),
            ));
          }
        }
        if (entries.isNotEmpty) return;
      }
    }
    for (final provider in CliProvider.values) {
      final candidate = provider == CliProvider.claudeCode
          ? map['claude-code'] ?? map['claudeCode'] ?? map['claude']
          : map['codex'];
      if (candidate is Map) {
        entries.add((
          hint: provider,
          value: Map<String, dynamic>.from(candidate),
        ));
      }
    }
    if (entries.isEmpty) entries.add((hint: null, value: map));
  }

  collect(raw);
  final byProvider = <CliProvider, CliUpdateItem>{};
  for (final entry in entries) {
    final item = CliUpdateItem.fromJson(entry.value, hint: entry.hint);
    byProvider[item.provider] = item;
  }
  return CliProvider.values
      .where(byProvider.containsKey)
      .map((provider) => byProvider[provider]!)
      .toList(growable: false);
}
