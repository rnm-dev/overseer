import 'package:dio/dio.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/database/app_database.dart';
import 'package:overseer_mobile/features/peon/data/dio_peon_management_repository.dart';
import 'package:overseer_mobile/features/peon/domain/peon_management_models.dart';
import 'package:overseer_mobile/features/peon/domain/peon_management_repository.dart';
import 'package:overseer_mobile/features/peon/domain/peon_settings_models.dart';

void main() {
  late AppDatabase database;

  const scope = PeonSettingsScope(
    workspaceId: 'workspace/a',
    peonId: 'peon/b',
    online: true,
  );

  setUp(() {
    database = AppDatabase.forTesting(NativeDatabase.memory());
  });

  tearDown(() => database.close());

  test(
    'loads every opaque-cursor Armory page and caches the inventory',
    () async {
      final requests = <RequestOptions>[];
      final dio = Dio();
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            requests.add(options);
            final cursor = options.queryParameters['cursor'];
            handler.resolve(
              Response<Map<String, dynamic>>(
                requestOptions: options,
                data: {
                  'registry': {
                    'source': 'live',
                    'official': true,
                    'fetchedAt': 12,
                  },
                  'packages': [
                    {
                      'id': cursor == null ? 'cloudflare' : 'heroboard',
                      'available': true,
                      'displayName': cursor == null
                          ? 'Cloudflare'
                          : 'Heroboard',
                      'latestVersion': '1.0.0',
                      'installed': null,
                      'updateAvailable': null,
                    },
                  ],
                  'total': 2,
                  'nextCursor': cursor == null ? 'opaque-next' : null,
                },
              ),
            );
          },
        ),
      );
      final repository = DioPeonManagementRepository(
        database: database,
        dio: dio,
      );

      final inventory = await repository.fetchArmory(scope);
      final cached = await repository.loadCachedArmory(scope);

      expect(requests, hasLength(2));
      expect(requests.first.queryParameters, {'limit': 100});
      expect(requests.last.queryParameters, {
        'limit': 100,
        'cursor': 'opaque-next',
      });
      expect(inventory.packages.map((item) => item.id), [
        'cloudflare',
        'heroboard',
      ]);
      expect(cached?.packages.map((item) => item.id), [
        'cloudflare',
        'heroboard',
      ]);
    },
  );

  test(
    'normalizes provider updates and uses only supported mutation routes',
    () async {
      final requests = <RequestOptions>[];
      final dio = Dio();
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            requests.add(options);
            if (options.path.endsWith('/ai/cli-updates')) {
              handler.resolve(
                Response<Object>(
                  requestOptions: options,
                  data: {
                    'providers': [
                      {
                        'provider': 'codex',
                        'currentVersion': '1.0.0',
                        'latestVersion': '1.1.0',
                        'updateAvailable': true,
                        'operation': null,
                      },
                      {
                        'provider': 'claude-code',
                        'currentVersion': '2.0.0',
                        'latestVersion': '2.0.0',
                        'updateAvailable': false,
                        'operation': null,
                      },
                    ],
                  },
                ),
              );
              return;
            }
            handler.resolve(
              Response<Map<String, dynamic>>(
                requestOptions: options,
                data: options.path.contains('/armory/')
                    ? {
                        'operation': {
                          'id': 'operation',
                          'kind': 'disable',
                          'status': 'queued',
                        },
                      }
                    : const {},
                statusCode: options.path.contains('/ai/cli-updates/')
                    ? 202
                    : 200,
              ),
            );
          },
        ),
      );
      final repository = DioPeonManagementRepository(
        database: database,
        dio: dio,
      );

      final updates = await repository.fetchCliUpdates(scope, refresh: true);
      await repository.startCliUpdate(scope, CliProvider.codex);
      final operation = await repository.mutateArmory(
        scope,
        'cloudflare/package',
        ArmoryAction.disable,
      );

      expect(updates.map((item) => item.provider), [
        CliProvider.codex,
        CliProvider.claudeCode,
      ]);
      expect(requests[0].queryParameters, {'refresh': 'true'});
      expect(requests[1].path, endsWith('/ai/cli-updates/codex'));
      expect(
        requests[2].path,
        endsWith('/armory/packages/cloudflare%2Fpackage/disable'),
      );
      expect(operation.status, 'queued');
    },
  );

  test('reports a final 404 as an unsupported older Peon', () async {
    final dio = Dio();
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) => handler.reject(
          DioException(
            requestOptions: options,
            response: Response<Map<String, dynamic>>(
              requestOptions: options,
              statusCode: 404,
              data: const {'error': 'not found'},
            ),
          ),
        ),
      ),
    );
    final repository = DioPeonManagementRepository(
      database: database,
      dio: dio,
    );

    await expectLater(
      repository.fetchCliUpdates(scope),
      throwsA(
        isA<PeonManagementException>().having(
          (error) => error.unsupported,
          'unsupported',
          isTrue,
        ),
      ),
    );
  });
}
