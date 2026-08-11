import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:drift/drift.dart';

import '../../../core/database/app_database.dart';
import '../../../core/time/app_time.dart';
import '../domain/ai_stats_models.dart';
import '../domain/ai_stats_repository.dart';

class DioAiStatsRepository implements AiStatsRepository {
  DioAiStatsRepository({
    required this.database,
    required this._dio,
    this._clock = const SystemAppClock(),
  });

  final AppDatabase database;
  final Dio _dio;
  final AppClock _clock;

  @override
  Future<AiStats?> loadCachedStats({
    required String workspaceId,
    required String peonId,
    required AiStatsPeriod period,
  }) async {
    final row =
        await (database.select(database.cachedAiStats)..where(
              (row) =>
                  row.workspaceId.equals(workspaceId) &
                  row.peonId.equals(peonId) &
                  row.period.equals(period.apiValue),
            ))
            .getSingleOrNull();
    if (row == null) return null;
    try {
      return AiStats.fromJson(
        Map<String, dynamic>.from(jsonDecode(row.payloadJson) as Map),
      );
    } on FormatException {
      return null;
    } on TypeError {
      return null;
    }
  }

  @override
  Future<AiStats> refreshStats({
    required String workspaceId,
    required String peonId,
    required AiStatsPeriod period,
  }) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        'workspaces/${Uri.encodeComponent(workspaceId)}/peons/'
        '${Uri.encodeComponent(peonId)}/stats',
        queryParameters: {'period': period.apiValue},
      );
      final payload = response.data;
      if (payload == null) {
        throw const FormatException('Empty stats response');
      }
      final stats = AiStats.fromJson(payload);
      await database
          .into(database.cachedAiStats)
          .insertOnConflictUpdate(
            CachedAiStatsCompanion.insert(
              workspaceId: workspaceId,
              peonId: peonId,
              period: period.apiValue,
              payloadJson: jsonEncode(stats.toJson()),
              updatedAt: _clock.now().millisecondsSinceEpoch.toDouble(),
            ),
          );
      return stats;
    } on DioException catch (error) {
      final payload = error.response?.data;
      final serverMessage = payload is Map
          ? payload['error']?.toString()
          : null;
      throw AiStatsException(
        serverMessage ?? 'Could not load AI statistics.',
        unsupported: error.response?.statusCode == 404,
      );
    } on FormatException {
      throw const AiStatsException(
        'Overseer returned an invalid statistics response.',
      );
    } on TypeError {
      throw const AiStatsException(
        'Overseer returned an invalid statistics response.',
      );
    }
  }

  @override
  Future<AiProviderQuota> loadQuota({
    required String workspaceId,
    required String peonId,
    required AiProvider provider,
    bool refresh = false,
  }) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        'workspaces/${Uri.encodeComponent(workspaceId)}/peons/'
        '${Uri.encodeComponent(peonId)}/quota/'
        '${Uri.encodeComponent(provider.apiValue)}',
        queryParameters: refresh ? {'refresh': '1'} : null,
      );
      final payload = response.data;
      if (payload == null) {
        throw const FormatException('Empty quota response');
      }
      return AiProviderQuota.fromJson(payload);
    } on DioException catch (error) {
      final payload = error.response?.data;
      final serverMessage = payload is Map
          ? payload['error']?.toString()
          : null;
      throw AiStatsException(
        serverMessage ?? 'Could not load ${provider.label} quota.',
      );
    } on FormatException {
      throw const AiStatsException(
        'Overseer returned an invalid quota response.',
      );
    } on TypeError {
      throw const AiStatsException(
        'Overseer returned an invalid quota response.',
      );
    }
  }

  @override
  Future<AiProviderCapabilities> loadCapabilities({
    required String workspaceId,
    required String peonId,
    required AiProvider provider,
    bool refresh = false,
  }) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        'workspaces/${Uri.encodeComponent(workspaceId)}/peons/'
        '${Uri.encodeComponent(peonId)}/capabilities/'
        '${Uri.encodeComponent(provider.apiValue)}',
        queryParameters: refresh ? {'refresh': '1'} : null,
      );
      final payload = response.data;
      if (payload == null) {
        throw const FormatException('Empty capabilities response');
      }
      return AiProviderCapabilities.fromJson(payload);
    } on DioException catch (error) {
      final payload = error.response?.data;
      final serverMessage = payload is Map
          ? payload['error']?.toString()
          : null;
      throw AiStatsException(
        serverMessage ?? 'Could not load ${provider.label} capabilities.',
      );
    } on FormatException {
      throw const AiStatsException(
        'Overseer returned an invalid capabilities response.',
      );
    } on TypeError {
      throw const AiStatsException(
        'Overseer returned an invalid capabilities response.',
      );
    }
  }
}
