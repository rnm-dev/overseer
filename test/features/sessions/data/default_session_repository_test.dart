import 'package:dio/dio.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/database/app_database.dart';
import 'package:overseer_mobile/features/sessions/data/default_session_repository.dart';

void main() {
  late AppDatabase database;
  late DefaultSessionRepository repository;

  setUp(() {
    database = AppDatabase.forTesting(NativeDatabase.memory());
    repository = DefaultSessionRepository(
      database: database,
      apiUrl: Uri.parse('https://overseer.example/api/'),
      token: 'test-token',
    );
  });

  tearDown(() => database.close());

  test('cancels a running session through the Overseer proxy', () async {
    RequestOptions? request;
    final dio = Dio(BaseOptions(baseUrl: 'https://overseer.example/api/'));
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          request = options;
          handler.resolve(
            Response<void>(requestOptions: options, statusCode: 200),
          );
        },
      ),
    );
    repository = DefaultSessionRepository(
      database: database,
      apiUrl: Uri.parse('https://overseer.example/api/'),
      token: 'test-token',
      dio: dio,
    );

    await repository.cancelSession(
      workspaceId: 'workspace',
      peonId: 'peon',
      sessionId: 'session/id',
    );

    expect(request?.method, 'POST');
    expect(
      request?.path,
      'workspaces/workspace/peons/peon/sessions/session%2Fid/cancel',
    );
  });

  test('renames a session through Overseer and updates the cache', () async {
    RequestOptions? request;
    final dio = Dio(BaseOptions(baseUrl: 'https://overseer.example/api/'));
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          request = options;
          handler.resolve(
            Response<void>(requestOptions: options, statusCode: 200),
          );
        },
      ),
    );
    repository = DefaultSessionRepository(
      database: database,
      apiUrl: Uri.parse('https://overseer.example/api/'),
      token: 'test-token',
      dio: dio,
    );
    await repository.applyLiveProjection(
      workspaceId: 'workspace',
      cursor: 1,
      projection: {
        'peonId': 'peon',
        'sessionId': 'session/id',
        'title': 'Old name',
        'syncedAt': 10,
      },
    );

    await repository.renameSession(
      workspaceId: 'workspace',
      peonId: 'peon',
      sessionId: 'session/id',
      title: 'New name',
    );

    expect(request?.method, 'PATCH');
    expect(
      request?.path,
      'workspaces/workspace/peons/peon/sessions/session%2Fid',
    );
    expect(request?.data, {'title': 'New name'});
    final cached = await repository.loadCachedSessions(
      workspaceId: 'workspace',
      peonId: 'peon',
    );
    expect(cached.single.title, 'New name');
  });

  test(
    'deletes a session through Overseer and removes it from cache',
    () async {
      RequestOptions? request;
      final dio = Dio(BaseOptions(baseUrl: 'https://overseer.example/api/'));
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            request = options;
            handler.resolve(
              Response<void>(requestOptions: options, statusCode: 204),
            );
          },
        ),
      );
      repository = DefaultSessionRepository(
        database: database,
        apiUrl: Uri.parse('https://overseer.example/api/'),
        token: 'test-token',
        dio: dio,
      );
      await repository.applyLiveProjection(
        workspaceId: 'workspace',
        cursor: 1,
        projection: {
          'peonId': 'peon',
          'sessionId': 'session/id',
          'title': 'Disposable session',
          'syncedAt': 10,
        },
      );

      await repository.deleteSession(
        workspaceId: 'workspace',
        peonId: 'peon',
        sessionId: 'session/id',
      );

      expect(request?.method, 'DELETE');
      expect(
        request?.path,
        'workspaces/workspace/peons/peon/sessions/session%2Fid',
      );
      final cached = await repository.loadCachedSessions(
        workspaceId: 'workspace',
        peonId: 'peon',
      );
      expect(cached, isEmpty);
    },
  );

  test(
    'live activity updates reorder cached sessions and persist cursor',
    () async {
      final emitted = <List<String>>[];
      final subscription = repository
          .watchSessions(workspaceId: 'workspace', peonId: 'peon')
          .listen(
            (sessions) => emitted.add(
              sessions.map((session) => session.sessionId).toList(),
            ),
          );

      await repository.applyLiveProjection(
        workspaceId: 'workspace',
        cursor: 1,
        projection: {
          'peonId': 'peon',
          'sessionId': 'older',
          'title': 'Older',
          'lastActivityAt': 10,
          'syncedAt': 10,
        },
      );
      await repository.applyLiveProjection(
        workspaceId: 'workspace',
        cursor: 2,
        projection: {
          'peonId': 'peon',
          'sessionId': 'newer',
          'title': 'Newer',
          'lastActivityAt': 20,
          'syncedAt': 20,
        },
      );
      await repository.applyLiveProjection(
        workspaceId: 'workspace',
        cursor: 3,
        projection: {
          'peonId': 'peon',
          'sessionId': 'older',
          'title': 'Older, now active',
          'lastActivityAt': 30,
          'syncedAt': 30,
        },
      );

      await pumpEventQueue();

      expect(emitted.last, ['older', 'newer']);
      expect(await repository.cursorFor('workspace'), 3);
      await subscription.cancel();
    },
  );

  test('older live projection cannot regress or delete a newer row', () async {
    await repository.applyLiveProjection(
      workspaceId: 'workspace',
      cursor: 5,
      projection: {
        'peonId': 'peon',
        'sessionId': 'session',
        'title': 'Current',
        'lastActivityAt': 50,
        'syncedAt': 50,
      },
    );
    await repository.applyLiveProjection(
      workspaceId: 'workspace',
      cursor: 6,
      projection: {
        'peonId': 'peon',
        'sessionId': 'session',
        'title': 'Stale',
        'lastActivityAt': 10,
        'syncedAt': 10,
      },
    );
    await repository.applyLiveProjection(
      workspaceId: 'workspace',
      cursor: 7,
      projection: {
        'peonId': 'peon',
        'sessionId': 'session',
        'deleted': true,
        'syncedAt': 40,
      },
    );

    final sessions = await repository
        .watchSessions(workspaceId: 'workspace', peonId: 'peon')
        .first;

    expect(sessions.single.title, 'Current');
    expect(await repository.cursorFor('workspace'), 7);
  });

  test('fetches the requested REST page and caches its sessions', () async {
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
                'sessions': [
                  {
                    'peonId': 'peon',
                    'sessionId': 'remote',
                    'title': 'Remote session',
                    'status': 'running',
                    'lastActivityAt': 100,
                    'syncedAt': 100,
                  },
                ],
                'total': 3,
                'limit': 1,
                'offset': 1,
                'catalogs': [
                  {'peonId': 'peon', 'stale': true},
                ],
              },
            ),
          );
        },
      ),
    );
    repository = DefaultSessionRepository(
      database: database,
      apiUrl: Uri.parse('https://overseer.example/api/'),
      token: 'test-token',
      dio: dio,
    );

    final page = await repository.fetchPage(
      workspaceId: 'workspace',
      peonId: 'peon',
      offset: 1,
      limit: 1,
    );

    expect(request?.path, 'workspaces/workspace/sessions');
    expect(request?.queryParameters, {
      'peonId': 'peon',
      'limit': 1,
      'offset': 1,
    });
    expect(page.hasMore, isTrue);
    expect(page.catalogStale, isTrue);
    final cached = await repository.loadCachedSessions(
      workspaceId: 'workspace',
      peonId: 'peon',
    );
    expect(cached.single.sessionId, 'remote');
  });

  test('fetches session turn and token statistics', () async {
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
                'turnCount': 3,
                'usage': {
                  'inputTokens': 1200,
                  'outputTokens': 456,
                  'cacheCreationInputTokens': 80,
                  'cacheReadInputTokens': 900,
                },
              },
            ),
          );
        },
      ),
    );
    repository = DefaultSessionRepository(
      database: database,
      apiUrl: Uri.parse('https://overseer.example/api/'),
      token: 'test-token',
      dio: dio,
    );

    final details = await repository.fetchDetails(
      workspaceId: 'workspace',
      peonId: 'peon',
      sessionId: 'session/id',
    );

    expect(
      request?.path,
      'workspaces/workspace/peons/peon/sessions/session%2Fid',
    );
    expect(details.turnCount, 3);
    expect(details.usage?.inputTokens, 1200);
    expect(details.usage?.outputTokens, 456);
    expect(details.usage?.cacheCreationInputTokens, 80);
    expect(details.usage?.cacheReadInputTokens, 900);
  });

  test(
    'caches durable transcript pages by event id in display order',
    () async {
      final requests = <RequestOptions>[];
      final dio = Dio();
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            requests.add(options);
            final older = options.queryParameters['cursor'] == 'before-2';
            handler.resolve(
              Response<Map<String, dynamic>>(
                requestOptions: options,
                data: older
                    ? {
                        'events': [
                          {
                            'eventId': 'event-0',
                            'type': 'user_message',
                            'text': 'oldest',
                          },
                          {
                            'eventId': 'event-1',
                            'type': 'assistant',
                            'message': {
                              'content': [
                                {'type': 'text', 'text': 'older'},
                              ],
                            },
                          },
                          {
                            'eventId': 'event-2',
                            'type': 'assistant',
                            'text': 'overlap',
                          },
                        ],
                        'nextCursor': null,
                        'hasMore': false,
                      }
                    : {
                        'events': [
                          {
                            'eventId': 'event-2',
                            'type': 'assistant',
                            'text': 'overlap',
                          },
                          {
                            'eventId': 'event-3',
                            'type': 'result',
                            'num_turns': 1,
                          },
                        ],
                        'nextCursor': 'before-2',
                        'hasMore': true,
                      },
              ),
            );
          },
        ),
      );
      repository = DefaultSessionRepository(
        database: database,
        apiUrl: Uri.parse('https://overseer.example/api/'),
        token: 'test-token',
        dio: dio,
      );

      final latest = await repository.fetchLatestTranscript(
        workspaceId: 'workspace',
        peonId: 'peon',
        sessionId: 'session/id',
        limit: 2,
      );
      final older = await repository.fetchOlderTranscript(
        workspaceId: 'workspace',
        peonId: 'peon',
        sessionId: 'session/id',
        cursor: latest.nextCursor!,
        limit: 3,
      );
      final cached = await repository.loadCachedTranscript(
        workspaceId: 'workspace',
        peonId: 'peon',
        sessionId: 'session/id',
      );

      expect(latest.insertedCount, 2);
      expect(older.insertedCount, 2);
      expect(cached.hasOlder, isFalse);
      expect(cached.events.map((event) => event.eventId), [
        'event-0',
        'event-1',
        'event-2',
        'event-3',
      ]);
      expect(cached.events[1].displayText, 'older');
      expect(cached.events.last.displayText, 'Run finished · 1 turns');
      expect(
        requests.first.path,
        'workspaces/workspace/peons/peon/sessions/session%2Fid/transcript',
      );
      expect(requests.first.queryParameters, {'limit': 2});
      expect(requests.last.queryParameters, {'limit': 3, 'cursor': 'before-2'});

      await repository.cacheTailEvent(
        workspaceId: 'workspace',
        peonId: 'peon',
        sessionId: 'session/id',
        eventId: 'event-4',
        payload: {'type': 'assistant', 'text': 'live'},
      );
      await repository.cacheTailEvent(
        workspaceId: 'workspace',
        peonId: 'peon',
        sessionId: 'session/id',
        eventId: 'event-4',
        payload: {
          'type': 'assistant',
          'text': 'live enriched',
          'createdAt': 123,
        },
      );
      final withTail = await repository.loadCachedTranscript(
        workspaceId: 'workspace',
        peonId: 'peon',
        sessionId: 'session/id',
      );
      expect(withTail.events.map((event) => event.eventId), [
        'event-0',
        'event-1',
        'event-2',
        'event-3',
        'event-4',
      ]);
      expect(withTail.events.last.displayText, 'live enriched');
    },
  );
}
