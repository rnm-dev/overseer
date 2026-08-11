import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/sessions/data/dio_session_file_repository.dart';

void main() {
  test(
    'opens absolute durable attachment paths through the session API',
    () async {
      final requests = <RequestOptions>[];
      final dio = Dio(BaseOptions(baseUrl: 'https://overseer.example/api/'));
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            requests.add(options);
            return handler.resolve(
              Response<Map<String, dynamic>>(
                requestOptions: options,
                data: {'binary': false, 'content': '# Shared file'},
              ),
            );
          },
        ),
      );
      final repository = DioSessionFileRepository(dio: dio);

      final preview = await repository.fetchAttachment(
        workspaceId: 'workspace',
        peonId: 'peon',
        sessionId: 'shared-session',
        path: '/var/lib/peon/uploads/command/notes.md',
        name: 'notes.md',
        type: 'file',
      );

      expect(String.fromCharCodes(preview.bytes), '# Shared file');
      expect(preview.path, 'notes.md');
      expect(
        requests.single.uri.path,
        contains('/sessions/shared-session/file'),
      );
      expect(
        requests.single.queryParameters['path'],
        '/var/lib/peon/uploads/command/notes.md',
      );
    },
  );

  test('keeps relative attachment paths on the transfer API', () async {
    final requests = <RequestOptions>[];
    final dio = Dio(BaseOptions(baseUrl: 'https://overseer.example/api/'));
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          requests.add(options);
          return handler.resolve(
            Response<List<int>>(
              requestOptions: options,
              data: Uint8List.fromList([1, 2, 3]),
            ),
          );
        },
      ),
    );
    final repository = DioSessionFileRepository(dio: dio);

    await repository.fetchAttachment(
      workspaceId: 'workspace',
      peonId: 'peon',
      sessionId: 'session',
      path: r'uploads\command\photo.png',
      name: 'photo.png',
      type: 'image',
    );

    expect(
      requests.single.uri.path,
      '/api/workspaces/workspace/peons/peon/files/uploads/command/photo.png',
    );
  });
}
