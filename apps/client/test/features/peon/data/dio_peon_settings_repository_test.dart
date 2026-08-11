import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/peon/data/dio_peon_settings_repository.dart';
import 'package:overseer_mobile/features/peon/domain/peon_settings_models.dart';
import 'package:overseer_mobile/features/peon/domain/peon_settings_repository.dart';

void main() {
  const scope = PeonSettingsScope(
    workspaceId: 'workspace/a',
    peonId: 'peon/b',
    online: true,
  );

  test(
    'loads settings, status, and model catalog from scoped routes',
    () async {
      final paths = <String>[];
      final dio = Dio();
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            paths.add(options.path);
            final data = switch (options.path) {
              final path when path.endsWith('/settings') => <String, dynamic>{
                'name': 'Kanat',
                'fileTransferRoot': '/tmp/peon',
                'heartbeatIntervalMs': 5000,
                'defaultAgent': 'codex',
                'soul': 'Careful and precise.',
              },
              final path when path.endsWith('/status') => <String, dynamic>{
                'updateAvailable': true,
                'updateLocalSha': 'abc',
              },
              _ => <String, dynamic>{
                'defaultAgent': 'codex',
                'providers': [
                  {
                    'agent': 'codex',
                    'label': 'Codex',
                    'models': [
                      {'id': 'gpt-5.6', 'label': 'GPT-5.6', 'default': true},
                    ],
                    'reasoningEfforts': [],
                  },
                ],
              },
            };
            handler.resolve(
              Response<Map<String, dynamic>>(
                requestOptions: options,
                data: data,
              ),
            );
          },
        ),
      );
      final repository = DioPeonSettingsRepository(dio: dio);

      final settings = await repository.fetchSettings(scope);
      final status = await repository.fetchStatus(scope);
      final catalog = await repository.fetchModelCatalog(scope);

      expect(
        paths,
        everyElement(startsWith('workspaces/workspace%2Fa/peons/peon%2Fb/')),
      );
      expect(settings.name, 'Kanat');
      expect(settings.heartbeatIntervalMs, 5000);
      expect(settings.soul, 'Careful and precise.');
      expect(status?.updateAvailable, isTrue);
      expect(catalog?.providers.single.models.single.id, 'gpt-5.6');
    },
  );

  test(
    'sends partial settings, connection, update, and delete mutations',
    () async {
      final requests = <RequestOptions>[];
      final dio = Dio();
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            requests.add(options);
            handler.resolve(
              Response<Map<String, dynamic>>(
                requestOptions: options,
                data: options.path.endsWith('/control/check-update')
                    ? {'updateAvailable': false}
                    : {'name': 'Renamed'},
              ),
            );
          },
        ),
      );
      final repository = DioPeonSettingsRepository(dio: dio);

      await repository.updateSettings(scope, {'name': 'Renamed'});
      await repository.updateConnection(scope, 'https://peon.example');
      await repository.checkForUpdate(scope);
      await repository.installUpdate(scope);
      await repository.deletePeon(scope);

      expect(requests[0].method, 'PATCH');
      expect(requests[0].data, {'name': 'Renamed'});
      expect(requests[1].data, {'publicUrl': 'https://peon.example'});
      expect(requests[2].path, endsWith('/control/check-update'));
      expect(requests[3].path, endsWith('/control/update'));
      expect(requests[4].method, 'DELETE');
    },
  );

  test('normalizes an invalid update status response', () async {
    final dio = Dio();
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) => handler.resolve(
          Response<Map<String, dynamic>>(
            requestOptions: options,
            data: {'updateAvailable': 'not-a-boolean'},
          ),
        ),
      ),
    );
    final repository = DioPeonSettingsRepository(dio: dio);

    await expectLater(
      repository.checkForUpdate(scope),
      throwsA(
        isA<PeonSettingsException>().having(
          (error) => error.message,
          'message',
          'Overseer returned an invalid Peon update status.',
        ),
      ),
    );
  });
}
