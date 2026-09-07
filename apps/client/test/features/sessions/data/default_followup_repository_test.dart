import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/database/app_database.dart';
import 'package:overseer_mobile/features/sessions/data/default_followup_repository.dart';
import 'package:overseer_mobile/features/sessions/domain/followup_repository.dart';
import 'package:overseer_mobile/features/sessions/domain/new_session_repository.dart';
import 'package:overseer_mobile/shared/models/ai_capabilities.dart';

void main() {
  const scope = FollowupScope(
    workspaceId: 'workspace',
    peonId: 'peon',
    sessionId: 'session',
  );

  late AppDatabase database;

  setUp(() {
    database = AppDatabase.forTesting(NativeDatabase.memory());
  });

  tearDown(() => database.close());

  test('persists and clears a session-scoped draft', () async {
    final repository = DefaultFollowupRepository(
      database: database,
      dio: Dio(),
    );

    await repository.saveDraft(
      scope,
      const ComposerDraftState(
        text: 'durable draft',
        agent: 'codex',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'high',
      ),
    );
    final restored = await repository.loadDraft(scope);
    expect(restored.text, 'durable draft');
    expect(restored.agent, 'codex');
    expect(restored.model, 'gpt-5.6-sol');
    expect(restored.reasoningEffort, 'high');

    await repository.saveDraft(scope, const ComposerDraftState());
    expect((await repository.loadDraft(scope)).text, isEmpty);
  });

  test(
    'retries transient follow-ups with the same command id in FIFO order',
    () async {
      final requests = <RequestOptions>[];
      var rejectFirst = true;
      final dio = Dio(BaseOptions(baseUrl: 'https://overseer.example/api/'));
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            requests.add(options);
            if (rejectFirst) {
              rejectFirst = false;
              handler.reject(
                DioException(
                  requestOptions: options,
                  type: DioExceptionType.connectionTimeout,
                ),
              );
              return;
            }
            handler.resolve(
              Response<void>(requestOptions: options, statusCode: 200),
            );
          },
        ),
      );
      final repository = DefaultFollowupRepository(
        database: database,
        dio: dio,
      );

      expect(
        await repository.submit(
          scope: scope,
          prompt: 'first',
          serverQueue: false,
          agent: 'codex',
          model: 'gpt-5',
          reasoningEffort: 'high',
        ),
        FollowupDelivery.queued,
      );
      expect(
        await repository.submit(
          scope: scope,
          prompt: 'second',
          serverQueue: false,
        ),
        FollowupDelivery.queued,
      );
      expect(requests.map((request) => request.data['prompt']), ['first']);

      expect(await repository.retryPending(scope), isFalse);
      expect(requests.map((request) => request.data['prompt']), [
        'first',
        'first',
        'second',
      ]);
      expect(
        requests[0].headers['Peon-Request-Id'],
        requests[1].headers['Peon-Request-Id'],
      );
      expect(requests[0].data['model'], 'gpt-5');
      expect(requests[1].data, isNot(contains('agent')));
      expect(requests[1].data['model'], 'gpt-5');
      expect(requests[1].data['reasoningEffort'], 'high');
      expect(
        requests[1].headers['Peon-Request-Id'],
        isNot(requests[2].headers['Peon-Request-Id']),
      );
      expect(await repository.watchPending(scope).first, isEmpty);
    },
  );

  test(
    'uploads follow-up attachments once and durably retries their paths',
    () async {
      final requests = <RequestOptions>[];
      var rejectFollowup = true;
      final progress = <FollowupSubmissionProgress>[];
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
                  data: {'path': 'uploads/followup-command/screenshot.png'},
                ),
              );
              return;
            }
            if (rejectFollowup) {
              rejectFollowup = false;
              handler.reject(
                DioException(
                  requestOptions: options,
                  type: DioExceptionType.connectionTimeout,
                ),
              );
              return;
            }
            handler.resolve(
              Response<void>(requestOptions: options, statusCode: 200),
            );
          },
        ),
      );
      final repository = DefaultFollowupRepository(
        database: database,
        dio: dio,
      );

      expect(
        await repository.submit(
          scope: scope,
          prompt: '',
          serverQueue: false,
          commandId: 'followup-command',
          attachments: [
            NewSessionAttachment(
              name: 'screenshot.png',
              type: 'image',
              bytes: Uint8List.fromList([1, 2, 3]),
            ),
          ],
          onProgress: progress.add,
        ),
        FollowupDelivery.queued,
      );

      final pending = await repository.watchPending(scope).first;
      expect(pending.single.commandId, 'followup-command');
      expect(pending.single.prompt, '(see attachments)');
      expect(
        pending.single.attachments.single.path,
        endsWith('screenshot.png'),
      );
      expect(
        requests.where((request) => request.method == 'PUT'),
        hasLength(1),
      );
      expect(requests.first.headers['Peon-Content-Sha256'], hasLength(64));
      expect(progress.first.stage, FollowupSubmissionStage.uploading);
      expect(progress.last.stage, FollowupSubmissionStage.submitting);

      expect(await repository.retryPending(scope), isFalse);

      expect(
        requests.where((request) => request.method == 'PUT'),
        hasLength(1),
      );
      final posts = requests
          .where((request) => request.method == 'POST')
          .toList();
      expect(posts, hasLength(2));
      expect(posts.first.headers['Peon-Request-Id'], 'followup-command');
      expect(posts.last.headers['Peon-Request-Id'], 'followup-command');
      expect(posts.last.data['attachments'], [
        {
          'type': 'image',
          'path': 'uploads/followup-command/screenshot.png',
          'size': 3,
        },
      ]);
    },
  );

  test('loads the model capability catalog', () async {
    final dio = Dio(BaseOptions(baseUrl: 'https://overseer.example/api/'));
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) => handler.resolve(
          Response<Map<String, dynamic>>(
            requestOptions: options,
            statusCode: 200,
            data: {
              'defaultModel': 'gpt-5',
              'defaultAgent': 'codex',
              'providers': [
                {
                  'agent': 'codex',
                  'label': 'Codex',
                  'models': [
                    {'id': 'gpt-5', 'label': 'GPT-5', 'default': true},
                  ],
                  'reasoningEfforts': [
                    {'id': 'high', 'label': 'High'},
                  ],
                },
              ],
            },
          ),
        ),
      ),
    );
    final repository = DefaultFollowupRepository(database: database, dio: dio);

    final catalog = await repository.fetchModelCatalog(scope);

    expect(catalog?.defaultAgent, 'codex');
    expect(catalog?.providers.single.models.single.label, 'GPT-5');
    expect(catalog?.providers.single.reasoningEfforts.single.id, 'high');
  });

  test(
    'distinguishes unsupported model catalogs from transient failures',
    () async {
      Future<ModelsCatalog?> fetchFor(int status) async {
        final dio = Dio(BaseOptions(baseUrl: 'https://overseer.example/api/'));
        dio.interceptors.add(
          InterceptorsWrapper(
            onRequest: (options, handler) => handler.reject(
              DioException(
                requestOptions: options,
                response: Response<void>(
                  requestOptions: options,
                  statusCode: status,
                ),
                type: DioExceptionType.badResponse,
              ),
            ),
          ),
        );
        return DefaultFollowupRepository(
          database: database,
          dio: dio,
        ).fetchModelCatalog(scope);
      }

      expect(await fetchFor(404), isNull);
      await expectLater(fetchFor(503), throwsA(isA<FollowupException>()));
    },
  );

  test('uses the Peon server queue while a session is running', () async {
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
    final repository = DefaultFollowupRepository(database: database, dio: dio);

    expect(
      await repository.submit(
        scope: scope,
        prompt: 'urgent',
        serverQueue: true,
        startNow: true,
      ),
      FollowupDelivery.delivered,
    );
    expect(request?.path, contains('/sessions/session/queue'));
    expect(request?.data['prompt'], 'urgent');
    expect(request?.data['startNow'], isTrue);
    expect(request?.data['commandId'], isNotEmpty);
  });

  test('caches the authoritative FIFO queue and targets item actions', () async {
    final requests = <RequestOptions>[];
    var queueItems = <Map<String, dynamic>>[
      {
        'id': 'first',
        'sessionId': 'session',
        'prompt': 'Review plan',
        'attachments': [
          {'type': 'file', 'path': 'uploads/session/plan.md'},
        ],
        'queuedAt': 1,
      },
      {
        'id': 'item/2',
        'sessionId': 'session',
        'prompt': 'Ship it',
        'attachments': <Map<String, dynamic>>[],
        'queuedAt': 2,
      },
    ];
    final dio = Dio(BaseOptions(baseUrl: 'https://overseer.example/api/'));
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          requests.add(options);
          if (options.method == 'PATCH') {
            queueItems = [
              for (final item in queueItems)
                if (item['id'] == 'item/2')
                  {...item, 'prompt': options.data['prompt']}
                else
                  item,
            ];
          }
          if (options.method == 'DELETE') queueItems = [];
          handler.resolve(
            Response<Map<String, dynamic>>(
              requestOptions: options,
              statusCode: 200,
              data: options.method == 'GET' ? {'items': queueItems} : null,
            ),
          );
        },
      ),
    );
    final repository = DefaultFollowupRepository(database: database, dio: dio);

    await repository.refreshQueue(scope);
    final cached = await repository.watchQueue(scope).first;

    expect(cached.map((item) => item.id), ['first', 'item/2']);
    expect(cached.first.attachments.single.label, 'plan.md');

    await repository.editQueued(scope, 'item/2', 'Ship the release');

    expect(
      requests.map((request) => '${request.method} ${request.path}'),
      contains(
        'PATCH workspaces/workspace/peons/peon/sessions/session/queue/item%2F2',
      ),
    );
    expect(
      requests
          .firstWhere((request) => request.method == 'PATCH')
          .data['prompt'],
      'Ship the release',
    );
    expect(
      (await repository.watchQueue(scope).first).last.prompt,
      'Ship the release',
    );

    await repository.removeQueued(scope, 'item/2');

    expect(
      requests.map((request) => '${request.method} ${request.path}'),
      contains(
        'DELETE workspaces/workspace/peons/peon/sessions/session/queue/item%2F2',
      ),
    );
    expect(await repository.watchQueue(scope).first, isEmpty);
  });

  test(
    'reconciles an item already popped by the Peon without an error',
    () async {
      String? mutationPath;
      final dio = Dio(BaseOptions(baseUrl: 'https://overseer.example/api/'));
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            if (options.method == 'POST') {
              mutationPath = options.path;
              handler.reject(
                DioException.badResponse(
                  statusCode: 404,
                  requestOptions: options,
                  response: Response<Map<String, dynamic>>(
                    requestOptions: options,
                    statusCode: 404,
                    data: {
                      'code': 'UNKNOWN_QUEUE_ITEM',
                      'error': 'Unknown queue item',
                    },
                  ),
                ),
              );
              return;
            }
            handler.resolve(
              Response<Map<String, dynamic>>(
                requestOptions: options,
                statusCode: 200,
                data: {'items': <Object>[]},
              ),
            );
          },
        ),
      );
      final repository = DefaultFollowupRepository(
        database: database,
        dio: dio,
      );

      await expectLater(repository.steerQueued(scope, 'gone'), completes);
      expect(mutationPath, endsWith('/queue/gone/steer'));
    },
  );

  test('clears a cached queue and identifies an unsupported 404', () async {
    var unsupported = false;
    final dio = Dio(BaseOptions(baseUrl: 'https://overseer.example/api/'));
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          if (unsupported) {
            handler.reject(
              DioException.badResponse(
                statusCode: 404,
                requestOptions: options,
                response: Response<Map<String, dynamic>>(
                  requestOptions: options,
                  statusCode: 404,
                  data: const {
                    'code': 'UNKNOWN_SESSION',
                    'error': 'unknown session',
                  },
                ),
              ),
            );
            return;
          }
          handler.resolve(
            Response<Map<String, dynamic>>(
              requestOptions: options,
              statusCode: 200,
              data: {
                'items': [
                  {
                    'id': 'cached',
                    'sessionId': 'session',
                    'prompt': 'stale',
                    'attachments': <Object>[],
                    'queuedAt': 1,
                  },
                ],
              },
            ),
          );
        },
      ),
    );
    final repository = DefaultFollowupRepository(database: database, dio: dio);
    await repository.refreshQueue(scope);
    expect(await repository.watchQueue(scope).first, hasLength(1));

    unsupported = true;
    await expectLater(
      repository.refreshQueue(scope),
      throwsA(
        isA<FollowupException>().having(
          (error) => error.statusCode,
          'statusCode',
          404,
        ),
      ),
    );
    expect(await repository.watchQueue(scope).first, isEmpty);
  });

  test(
    'drops a permanently rejected command and exposes the server error',
    () async {
      final dio = Dio(BaseOptions(baseUrl: 'https://overseer.example/api/'));
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            handler.reject(
              DioException.badResponse(
                statusCode: 400,
                requestOptions: options,
                response: Response<Map<String, dynamic>>(
                  requestOptions: options,
                  statusCode: 400,
                  data: {'error': 'Rejected prompt'},
                ),
              ),
            );
          },
        ),
      );
      final repository = DefaultFollowupRepository(
        database: database,
        dio: dio,
      );

      await expectLater(
        repository.submit(scope: scope, prompt: 'bad', serverQueue: false),
        throwsA(
          isA<FollowupException>().having(
            (error) => error.message,
            'message',
            'Rejected prompt',
          ),
        ),
      );
      expect(await repository.watchPending(scope).first, isEmpty);
    },
  );
}
