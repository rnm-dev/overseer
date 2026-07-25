import 'package:dio/dio.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/database/app_database.dart';
import 'package:overseer_mobile/features/ai_stats/data/dio_ai_stats_repository.dart';
import 'package:overseer_mobile/features/ai_stats/domain/ai_stats_models.dart';

void main() {
  late AppDatabase database;

  setUp(() {
    database = AppDatabase.forTesting(NativeDatabase.memory());
  });

  tearDown(() => database.close());

  test('refreshes flat stats contract and saves it by period', () async {
    RequestOptions? request;
    final dio = Dio();
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          request = options;
          handler.resolve(
            Response<Map<String, dynamic>>(
              requestOptions: options,
              data: {
                'period': 'week',
                'sessionCount': 3,
                'outcomeCounts': {'success': 2, 'running': 1},
                'totalInputTokens': 100,
                'totalOutputTokens': 20,
                'totalCacheCreationTokens': 5,
                'totalCacheReadTokens': 80,
                'totalTokens': 205,
                'totalDurationMs': 3000,
                'totalCostUsd': 1.25,
                'sessionsWithUsage': 3,
                'sessionsMissingUsage': 0,
                'byModel': [
                  {
                    'agent': 'codex',
                    'model': 'gpt-5.4',
                    'sessionCount': 3,
                    'inputTokens': 100,
                    'outputTokens': 20,
                    'cacheCreationTokens': 5,
                    'cacheReadTokens': 80,
                    'totalTokens': 205,
                    'totalDurationMs': 3000,
                    'totalCostUsd': 1.25,
                  },
                ],
              },
            ),
          );
        },
      ),
    );
    final repository = DioAiStatsRepository(
      database: database,
      apiUrl: Uri.parse('https://overseer.example/api/'),
      token: 'token',
      dio: dio,
    );

    final stats = await repository.refreshStats(
      workspaceId: 'workspace',
      peonId: 'peon',
      period: AiStatsPeriod.week,
    );
    final cached = await repository.loadCachedStats(
      workspaceId: 'workspace',
      peonId: 'peon',
      period: AiStatsPeriod.week,
    );

    expect(request?.path, 'workspaces/workspace/peons/peon/stats');
    expect(request?.queryParameters['period'], 'week');
    expect(stats.totalTokens, 205);
    expect(stats.byModel.single.inputTokens, 100);
    expect(cached?.totalCostUsd, 1.25);
    expect(cached?.byModel.single.model, 'gpt-5.4');
  });

  test('keeps quota and capabilities provider-scoped', () async {
    final paths = <String>[];
    final dio = Dio();
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          paths.add(options.path);
          final capabilities = options.path.contains('/capabilities/');
          handler.resolve(
            Response<Map<String, dynamic>>(
              requestOptions: options,
              data: capabilities
                  ? {
                      'provider': 'codex',
                      'status': 'ok',
                      'updatedAt': 1,
                      'plugins': [],
                      'skills': [],
                      'mcps': [],
                    }
                  : {
                      'provider': 'codex',
                      'status': 'ok',
                      'source': 'oauth',
                      'updatedAt': 1,
                      'windows': [],
                    },
            ),
          );
        },
      ),
    );
    final repository = DioAiStatsRepository(
      database: database,
      apiUrl: Uri.parse('https://overseer.example/api/'),
      token: 'token',
      dio: dio,
    );

    await repository.loadQuota(
      workspaceId: 'workspace',
      peonId: 'peon',
      provider: AiProvider.codex,
      refresh: true,
    );
    await repository.loadCapabilities(
      workspaceId: 'workspace',
      peonId: 'peon',
      provider: AiProvider.codex,
      refresh: true,
    );

    expect(paths, [
      'workspaces/workspace/peons/peon/quota/codex',
      'workspaces/workspace/peons/peon/capabilities/codex',
    ]);
  });
}
