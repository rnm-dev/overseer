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

  test(
    'marks session attention read and clears the cached unread edge',
    () async {
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
          'attentionUnread': true,
          'attentionUpdatedAt': 10,
          'syncedAt': 10,
        },
      );

      await repository.markSessionAttentionRead(
        workspaceId: 'workspace',
        peonId: 'peon',
        sessionId: 'session/id',
      );

      expect(request?.method, 'POST');
      expect(
        request?.path,
        'workspaces/workspace/peons/peon/sessions/session%2Fid/attention/read',
      );
      final cached = await repository.loadCachedSessions(
        workspaceId: 'workspace',
        peonId: 'peon',
      );
      expect(cached.single.attentionUnread, isFalse);
      expect(cached.single.attentionUpdatedAt, greaterThan(10));
    },
  );

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
      await database.into(database.cachedProjects).insert(
        CachedProjectsCompanion.insert(
          workspaceId: 'workspace',
          peonId: 'peon',
          projectId: 'project',
          projectKey: 'project',
          sessionCount: const Value(2),
        ),
      );
      await repository.applyLiveProjection(
        workspaceId: 'workspace',
        cursor: 1,
        projection: {
          'peonId': 'peon',
          'sessionId': 'session/id',
          'projectId': 'project',
          'projectKey': 'project',
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
      final project = await database.select(database.cachedProjects).getSingle();
      expect(project.sessionCount, 1);
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

  test('live session projections assign authoritative project totals', () async {
    await database.batch((batch) {
      for (final project in [('one', 0), ('two', 7)]) {
        batch.insert(
          database.cachedProjects,
          CachedProjectsCompanion.insert(
            workspaceId: 'workspace',
            peonId: 'peon',
            projectId: project.$1,
            projectKey: project.$1,
            sessionCount: Value(project.$2),
          ),
        );
      }
    });

    final projection = {
      'peonId': 'peon',
      'sessionId': 'session',
      'projectId': 'one',
      'projectKey': 'one',
      'syncedAt': 10,
      'projectSessionCounts': [
        {'projectId': 'one', 'projectKey': 'one', 'sessionCount': 4},
        {'projectId': 'two', 'projectKey': 'two', 'sessionCount': 8},
      ],
    };
    await repository.applyLiveProjection(
      workspaceId: 'workspace',
      cursor: 1,
      projection: projection,
    );
    await repository.applyLiveProjection(
      workspaceId: 'workspace',
      cursor: 1,
      projection: projection,
    );

    final projects = await database.select(database.cachedProjects).get();
    expect({for (final project in projects) project.projectId: project.sessionCount}, {
      'one': 4,
      'two': 8,
    });
  });

  test(
    'attention projections update operator state without regressing session',
    () async {
      await repository.applyLiveProjection(
        workspaceId: 'workspace',
        cursor: 1,
        projection: {
          'peonId': 'peon',
          'sessionId': 'session',
          'title': 'Keep this title',
          'lastActivityAt': 20,
          'syncedAt': 20,
        },
      );

      await repository.applyAttentionProjection(
        workspaceId: 'workspace',
        cursor: 2,
        projection: {
          'peonId': 'peon',
          'sessionId': 'session',
          'hasOutstandingRequest': true,
          'lastRequestedAt': 25,
          'unread': false,
          'updatedAt': 25,
        },
      );

      final waiting = await repository.loadCachedSessions(
        workspaceId: 'workspace',
        peonId: 'peon',
      );
      expect(waiting.single.title, 'Keep this title');
      expect(waiting.single.operatorRequested, isTrue);
      expect(waiting.single.hasOutstandingRequest, isTrue);
      expect(waiting.single.lastRequestedAt, 25);

      await repository.applyAttentionProjection(
        workspaceId: 'workspace',
        cursor: 3,
        projection: {
          'peonId': 'peon',
          'sessionId': 'session',
          'hasOutstandingRequest': false,
          'lastRequestedAt': 25,
          'attentionUnread': true,
          'updatedAt': 30,
        },
      );

      final ready = await repository.loadCachedSessions(
        workspaceId: 'workspace',
        peonId: 'peon',
      );
      expect(ready.single.hasOutstandingRequest, isFalse);
      expect(ready.single.attentionUnread, isTrue);
      expect(ready.single.attentionUpdatedAt, 30);
      expect(await repository.cursorFor('workspace'), 3);
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

  test(
    'session page refresh preserves operator attention fields when omitted',
    () async {
      final dio = Dio();
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            handler.resolve(
              Response<Map<String, dynamic>>(
                requestOptions: options,
                data: {
                  'sessions': [
                    {
                      'peonId': 'peon',
                      'sessionId': 'recent',
                      'title': 'Updated title',
                      'status': 'running',
                      'lastActivityAt': 100,
                      'syncedAt': 100,
                      'attentionUnread': false,
                      'attentionUpdatedAt': 90,
                    },
                  ],
                  'total': 1,
                  'limit': 20,
                  'offset': 0,
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
      await repository.applyLiveProjection(
        workspaceId: 'workspace',
        cursor: 1,
        projection: {
          'peonId': 'peon',
          'sessionId': 'recent',
          'title': 'Original title',
          'status': 'running',
          'lastActivityAt': 50,
          'syncedAt': 50,
        },
      );
      await repository.applyAttentionProjection(
        workspaceId: 'workspace',
        cursor: 2,
        projection: {
          'peonId': 'peon',
          'sessionId': 'recent',
          'hasOutstandingRequest': true,
          'lastRequestedAt': 60,
          'attentionUnread': true,
          'updatedAt': 60,
        },
      );

      await repository.fetchPage(
        workspaceId: 'workspace',
        peonId: 'peon',
        offset: 0,
        limit: 20,
      );

      final cached = await repository.loadCachedSessions(
        workspaceId: 'workspace',
        peonId: 'peon',
      );
      expect(cached.single.title, 'Updated title');
      expect(cached.single.operatorRequested, isTrue);
      expect(cached.single.hasOutstandingRequest, isTrue);
      expect(cached.single.lastRequestedAt, 60);
      expect(cached.single.attentionUnread, isFalse);
      expect(cached.single.attentionUpdatedAt, 90);
    },
  );

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

  test('REST reconciliation inserts a missed event in server order', () async {
    await repository.cacheTailEvent(
      workspaceId: 'workspace',
      peonId: 'peon',
      sessionId: 'session',
      eventId: 'event-1',
      payload: {'type': 'assistant', 'text': 'first'},
    );
    await repository.cacheTailEvent(
      workspaceId: 'workspace',
      peonId: 'peon',
      sessionId: 'session',
      eventId: 'event-3',
      payload: {'type': 'assistant', 'text': 'third'},
    );
    final dio = Dio();
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) => handler.resolve(
          Response<Map<String, dynamic>>(
            requestOptions: options,
            data: {
              'events': [
                {'eventId': 'event-1', 'type': 'assistant', 'text': 'first'},
                {
                  'eventId': 'event-2',
                  'type': 'assistant',
                  'text': 'recovered',
                },
                {'eventId': 'event-3', 'type': 'assistant', 'text': 'third'},
              ],
              'nextCursor': null,
              'hasMore': false,
            },
          ),
        ),
      ),
    );
    repository = DefaultSessionRepository(
      database: database,
      apiUrl: Uri.parse('https://overseer.example/api/'),
      token: 'test-token',
      dio: dio,
    );

    await repository.fetchLatestTranscript(
      workspaceId: 'workspace',
      peonId: 'peon',
      sessionId: 'session',
    );

    final cached = await repository.loadCachedTranscript(
      workspaceId: 'workspace',
      peonId: 'peon',
      sessionId: 'session',
    );
    expect(cached.events.map((event) => event.eventId), [
      'event-1',
      'event-2',
      'event-3',
    ]);
  });
}
