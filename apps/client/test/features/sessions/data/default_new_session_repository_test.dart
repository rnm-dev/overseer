import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/database/app_database.dart';
import 'package:overseer_mobile/features/sessions/data/default_new_session_repository.dart';
import 'package:overseer_mobile/features/sessions/domain/new_session_repository.dart';

import '../../../support/manual_app_time.dart';

void main() {
  late AppDatabase database;

  setUp(() {
    database = AppDatabase.forTesting(NativeDatabase.memory());
  });

  tearDown(() => database.close());

  test(
    'uploads attachments and creates the cached session idempotently',
    () async {
      await database
          .into(database.cachedProjects)
          .insert(
            CachedProjectsCompanion.insert(
              workspaceId: 'workspace',
              peonId: 'peon',
              projectId: 'project-id',
              projectKey: 'project',
            ),
          );
      final requests = <RequestOptions>[];
      final progress = <NewSessionSubmissionProgress>[];
      final dio = Dio(BaseOptions(baseUrl: 'https://overseer.example/api/'));
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            requests.add(options);
            if (options.method == 'PUT') {
              handler.resolve(
                Response<Map<String, dynamic>>(
                  requestOptions: options,
                  statusCode: 200,
                  data: {'path': 'uploads/request/plan.md'},
                ),
              );
              return;
            }
            handler.resolve(
              Response<Map<String, dynamic>>(
                requestOptions: options,
                statusCode: 200,
                data: {'id': 'created-session'},
              ),
            );
          },
        ),
      );
      final clock = MutableAppClock(DateTime.utc(2026, 7, 27, 10, 30));
      final repository = DefaultNewSessionRepository(
        database: database,
        apiUrl: Uri.parse('https://overseer.example/api/'),
        token: 'token',
        dio: dio,
        clock: clock,
      );

      final session = await repository.createSession(
        NewSessionRequest(
          workspaceId: 'workspace',
          peonId: 'peon',
          requestId: 'request',
          prompt: '',
          projectKey: 'project',
          attachments: [
            NewSessionAttachment(
              name: 'plan.md',
              type: 'file',
              bytes: Uint8List.fromList([1, 2, 3]),
            ),
          ],
          onProgress: progress.add,
        ),
      );

      expect(session.sessionId, 'created-session');
      expect(requests, hasLength(2));
      expect(requests.first.path, contains('/files/uploads/request/plan.md'));
      expect(requests.first.headers['Peon-Content-Sha256'], hasLength(64));
      expect(requests.last.headers['Peon-Request-Id'], 'request');
      expect(requests.last.data['prompt'], '(see attachments)');
      expect(requests.last.data['attachments'], [
        {'type': 'file', 'path': 'uploads/request/plan.md'},
      ]);
      expect(progress, hasLength(2));
      expect(progress.first.stage, NewSessionSubmissionStage.uploading);
      expect(progress.first.current, 1);
      expect(progress.first.total, 1);
      expect(progress.first.fileName, 'plan.md');
      expect(progress.last.stage, NewSessionSubmissionStage.starting);
      final cached = await (database.select(
        database.cachedSessions,
      )).getSingle();
      expect(cached.sessionId, 'created-session');
      expect(cached.syncedAt, clock.now().millisecondsSinceEpoch.toDouble());
      final project = await database
          .select(database.cachedProjects)
          .getSingle();
      expect(project.sessionCount, 1);
    },
  );

  test(
    'a retried accepted session id does not increment its project twice',
    () async {
      await database
          .into(database.cachedProjects)
          .insert(
            CachedProjectsCompanion.insert(
              workspaceId: 'workspace',
              peonId: 'peon',
              projectId: 'project-id',
              projectKey: 'project',
            ),
          );
      final dio = Dio(BaseOptions(baseUrl: 'https://overseer.example/api/'));
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) => handler.resolve(
            Response<Map<String, dynamic>>(
              requestOptions: options,
              statusCode: 200,
              data: {
                'id': 'same-session',
                'projectId': 'project-id',
                'projectKey': 'project',
              },
            ),
          ),
        ),
      );
      final repository = DefaultNewSessionRepository(
        database: database,
        apiUrl: Uri.parse('https://overseer.example/api/'),
        token: 'token',
        dio: dio,
      );
      final request = NewSessionRequest(
        workspaceId: 'workspace',
        peonId: 'peon',
        requestId: 'request',
        prompt: 'Do it',
        projectKey: 'project',
      );

      await repository.createSession(request);
      await repository.createSession(request);

      final project = await database
          .select(database.cachedProjects)
          .getSingle();
      expect(project.sessionCount, 1);
    },
  );

  test('keeps upload failures specific and retryable', () async {
    final dio = Dio(BaseOptions(baseUrl: 'https://overseer.example/api/'));
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) => handler.reject(
          DioException(
            requestOptions: options,
            response: Response<void>(requestOptions: options, statusCode: 503),
          ),
        ),
      ),
    );
    final repository = DefaultNewSessionRepository(
      database: database,
      apiUrl: Uri.parse('https://overseer.example/api/'),
      token: 'token',
      dio: dio,
    );

    expect(
      () => repository.createSession(
        NewSessionRequest(
          workspaceId: 'workspace',
          peonId: 'peon',
          requestId: 'request',
          prompt: 'Review this',
          attachments: [
            NewSessionAttachment(
              name: 'plan.md',
              type: 'file',
              bytes: Uint8List.fromList([1, 2, 3]),
            ),
          ],
        ),
      ),
      throwsA(
        isA<NewSessionException>().having(
          (error) => error.message,
          'message',
          'Could not upload plan.md. Press Send to retry.',
        ),
      ),
    );
  });

  test('keeps sanitized upload names unique', () async {
    final requests = <RequestOptions>[];
    final dio = Dio(BaseOptions(baseUrl: 'https://overseer.example/api/'));
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          requests.add(options);
          if (options.method == 'PUT') {
            handler.resolve(
              Response<Map<String, dynamic>>(
                requestOptions: options,
                statusCode: 200,
                data: {'path': 'uploads/${options.path.split('/').last}'},
              ),
            );
            return;
          }
          handler.resolve(
            Response<Map<String, dynamic>>(
              requestOptions: options,
              statusCode: 200,
              data: {'id': 'created-session'},
            ),
          );
        },
      ),
    );
    final repository = DefaultNewSessionRepository(
      database: database,
      apiUrl: Uri.parse('https://overseer.example/api/'),
      token: 'token',
      dio: dio,
    );

    await repository.createSession(
      NewSessionRequest(
        workspaceId: 'workspace',
        peonId: 'peon',
        requestId: 'request',
        prompt: 'Review these',
        attachments: [
          NewSessionAttachment(
            name: 'report?.txt',
            type: 'file',
            bytes: Uint8List.fromList([1]),
          ),
          NewSessionAttachment(
            name: 'report*.txt',
            type: 'file',
            bytes: Uint8List.fromList([2]),
          ),
        ],
      ),
    );

    final uploadPaths = requests
        .where((request) => request.method == 'PUT')
        .map((request) => request.path)
        .toList();
    expect(uploadPaths[0], endsWith('/report_.txt'));
    expect(uploadPaths[1], endsWith('/report_-2.txt'));
    expect(requests.last.data['attachments'], [
      {'type': 'file', 'path': 'uploads/report_.txt'},
      {'type': 'file', 'path': 'uploads/report_-2.txt'},
    ]);
  });

  test('rejects an upload response without a path', () async {
    final dio = Dio(BaseOptions(baseUrl: 'https://overseer.example/api/'));
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) => handler.resolve(
          Response<Map<String, dynamic>>(
            requestOptions: options,
            statusCode: 200,
            data: const {},
          ),
        ),
      ),
    );
    final repository = DefaultNewSessionRepository(
      database: database,
      apiUrl: Uri.parse('https://overseer.example/api/'),
      token: 'token',
      dio: dio,
    );

    expect(
      () => repository.createSession(
        NewSessionRequest(
          workspaceId: 'workspace',
          peonId: 'peon',
          requestId: 'request',
          prompt: 'Review this',
          attachments: [
            NewSessionAttachment(
              name: 'plan.md',
              type: 'file',
              bytes: Uint8List.fromList([1, 2, 3]),
            ),
          ],
        ),
      ),
      throwsA(
        isA<NewSessionException>().having(
          (error) => error.message,
          'message',
          'Overseer returned an invalid upload response for plan.md.',
        ),
      ),
    );
  });
}
