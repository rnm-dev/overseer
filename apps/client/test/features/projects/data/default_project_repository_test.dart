import 'package:dio/dio.dart';
import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/database/app_database.dart';
import 'package:overseer_mobile/features/projects/data/default_project_repository.dart';
import 'package:overseer_mobile/features/projects/domain/project_detail_models.dart';
import 'package:overseer_mobile/features/projects/domain/project_models.dart';

void main() {
  late AppDatabase database;
  late DefaultProjectRepository repository;

  setUp(() {
    database = AppDatabase.forTesting(NativeDatabase.memory());
    repository = DefaultProjectRepository(
      database: database,
      apiUrl: Uri.parse('https://overseer.example/api/'),
      token: 'test-token',
    );
  });

  tearDown(() => database.close());

  test('fetches the peon project list and caches web rollup fields', () async {
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
                'projects': [
                  {
                    'projectId': 'project-1',
                    'key': 'overseer-mobile',
                    'name': 'Overseer Mobile',
                    'dir': '/projects/overseer-mobile',
                    'memberCount': 2,
                    'sessionCount': 20,
                    'activeCount': 5,
                    'lastActivityMs': 100,
                    'syncedAt': 110,
                  },
                ],
                'catalog': {'state': 'stale', 'stale': true, 'updatedAt': 110},
              },
            ),
          );
        },
      ),
    );
    repository = DefaultProjectRepository(
      database: database,
      apiUrl: Uri.parse('https://overseer.example/api/'),
      token: 'test-token',
      dio: dio,
    );

    final snapshot = await repository.refreshProjects(
      workspaceId: 'workspace',
      peonId: 'peon',
    );

    expect(request?.path, 'workspaces/workspace/peons/peon/projects');
    expect(snapshot.catalog.stale, isTrue);
    final cached = await repository.loadCachedProjects(
      workspaceId: 'workspace',
      peonId: 'peon',
    );
    expect(cached.single.displayName, 'Overseer Mobile');
    expect(cached.single.memberCount, 2);
    expect(cached.single.sessionCount, 20);
    expect(cached.single.activeCount, 5);
  });

  test('authoritative refresh retires a cached pre-rename identity', () async {
    await database.into(database.cachedProjects).insert(
      const CachedProjectsCompanion(
        workspaceId: Value('workspace'),
        peonId: Value('peon'),
        projectId: Value('legacy:old-key'),
        projectKey: Value('old-key'),
        name: Value('Old name'),
        dir: Value('/projects/shared'),
        syncedAt: Value(90),
      ),
    );

    final dio = Dio();
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) => handler.resolve(
          Response<Map<String, dynamic>>(
            requestOptions: options,
            data: {
              'projects': [
                {
                  'projectId': 'stable-project-id',
                  'key': 'new-key',
                  'name': 'New name',
                  'dir': '/projects/shared',
                  'syncedAt': 100,
                },
              ],
              'catalog': {'state': 'ready', 'stale': false},
            },
          ),
        ),
      ),
    );
    repository = DefaultProjectRepository(
      database: database,
      apiUrl: Uri.parse('https://overseer.example/api/'),
      token: 'test-token',
      dio: dio,
    );

    await repository.refreshProjects(workspaceId: 'workspace', peonId: 'peon');

    final cached = await repository.loadCachedProjects(
      workspaceId: 'workspace',
      peonId: 'peon',
    );
    expect(cached, hasLength(1));
    expect(cached.single.projectId, 'stable-project-id');
    expect(cached.single.key, 'new-key');
    expect(cached.single.displayName, 'New name');
  });

  test('suggests a key and directory using the web endpoint', () async {
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
                'key': 'overseer-mobile',
                'dir': '/projects/overseer-mobile',
              },
            ),
          );
        },
      ),
    );
    repository = DefaultProjectRepository(
      database: database,
      apiUrl: Uri.parse('https://overseer.example/api/'),
      token: 'test-token',
      dio: dio,
    );

    final suggestion = await repository.suggestProject(
      workspaceId: 'workspace',
      peonId: 'peon',
      label: 'Overseer Mobile',
    );

    expect(
      request?.path,
      'workspaces/workspace/peons/peon/projects/suggest-dir',
    );
    expect(request?.queryParameters, {'label': 'Overseer Mobile'});
    expect(suggestion.key, 'overseer-mobile');
    expect(suggestion.dir, '/projects/overseer-mobile');
  });

  test('creates a project with the same payload as web', () async {
    RequestOptions? request;
    final dio = Dio();
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          request = options;
          handler.resolve(
            Response<Map<String, dynamic>>(
              requestOptions: options,
              statusCode: 201,
              data: {'key': 'overseer-mobile'},
            ),
          );
        },
      ),
    );
    repository = DefaultProjectRepository(
      database: database,
      apiUrl: Uri.parse('https://overseer.example/api/'),
      token: 'test-token',
      dio: dio,
    );

    await repository.createProject(
      workspaceId: 'workspace',
      peonId: 'peon',
      label: 'Overseer Mobile',
      dir: '/projects/overseer-mobile',
      metadata: '# Mobile',
    );

    expect(request?.method, 'POST');
    expect(request?.path, 'workspaces/workspace/peons/peon/projects');
    expect(request?.data, {
      'label': 'Overseer Mobile',
      'dir': '/projects/overseer-mobile',
      'metadata': '# Mobile',
    });
  });

  test('loads and sorts a project directory using the web contract', () async {
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
                'path': 'lib/widgets',
                'entries': [
                  {'name': 'z.dart', 'type': 'file', 'size': 1500},
                  {'name': 'assets', 'type': 'dir'},
                  {'name': 'a.dart', 'type': 'file', 'size': 20},
                ],
              },
            ),
          );
        },
      ),
    );
    repository = DefaultProjectRepository(
      database: database,
      apiUrl: Uri.parse('https://overseer.example/api/'),
      token: 'test-token',
      dio: dio,
    );

    final directory = await repository.fetchDirectory(
      workspaceId: 'workspace one',
      peonId: 'peon/one',
      projectKey: 'mobile app',
      path: 'lib/widgets',
    );

    expect(
      request?.path,
      'workspaces/workspace%20one/peons/peon%2Fone/projects/'
      'mobile%20app/files/lib/widgets',
    );
    expect(request?.queryParameters, {'stat': 1, 'directory': 1});
    expect(directory.entries.map((entry) => entry.name), [
      'assets',
      'a.dart',
      'z.dart',
    ]);
    expect(directory.entries.last.size, 1500);
  });

  test('loads project file bytes using encoded project-key path', () async {
    RequestOptions? request;
    final dio = Dio();
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          request = options;
          handler.resolve(
            Response<List<int>>(
              requestOptions: options,
              data: const [35, 32, 72, 101, 108, 108, 111],
              headers: Headers.fromMap({
                Headers.contentTypeHeader: ['text/markdown'],
              }),
            ),
          );
        },
      ),
    );
    repository = DefaultProjectRepository(
      database: database,
      apiUrl: Uri.parse('https://overseer.example/api/'),
      token: 'test-token',
      dio: dio,
    );

    final ProjectFilePreview file = await repository.fetchFile(
      workspaceId: 'workspace',
      peonId: 'peon',
      projectKey: 'mobile app',
      path: 'docs/hello world.md',
    );

    expect(
      request?.path,
      'workspaces/workspace/peons/peon/projects/mobile%20app/files/'
      'docs/hello%20world.md',
    );
    expect(request?.responseType, ResponseType.bytes);
    expect(file.contentType, 'text/markdown');
    expect(file.bytes, [35, 32, 72, 101, 108, 108, 111]);
  });

  test('preserves the PROJECT_EXISTS error code', () async {
    final dio = Dio();
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) => handler.reject(
          DioException.badResponse(
            statusCode: 409,
            requestOptions: options,
            response: Response<Map<String, dynamic>>(
              requestOptions: options,
              statusCode: 409,
              data: {
                'error': 'project already exists',
                'code': 'PROJECT_EXISTS',
              },
            ),
          ),
        ),
      ),
    );
    repository = DefaultProjectRepository(
      database: database,
      apiUrl: Uri.parse('https://overseer.example/api/'),
      token: 'test-token',
      dio: dio,
    );

    expect(
      () => repository.createProject(
        workspaceId: 'workspace',
        peonId: 'peon',
        label: 'Existing',
      ),
      throwsA(
        isA<ProjectsException>()
            .having((error) => error.code, 'code', 'PROJECT_EXISTS')
            .having(
              (error) => error.message,
              'message',
              'project already exists',
            ),
      ),
    );
  });

  test(
    'live upsert and delete update the stream and cursor atomically',
    () async {
      await repository.applyLiveProjection(
        workspaceId: 'workspace',
        cursor: 4,
        projection: {
          'peonId': 'peon',
          'projectId': 'project-1',
          'key': 'overseer-mobile',
          'name': 'Overseer Mobile',
          'activeCount': 1,
          'syncedAt': 40,
        },
      );

      var projects = await repository
          .watchProjects(workspaceId: 'workspace', peonId: 'peon')
          .first;
      expect(projects.single.activeCount, 1);
      expect(await repository.cursorFor('workspace'), 4);

      await repository.applyLiveProjection(
        workspaceId: 'workspace',
        cursor: 5,
        projection: {
          'peonId': 'peon',
          'projectId': 'project-1',
          'deleted': true,
          'syncedAt': 50,
        },
      );

      projects = await repository
          .watchProjects(workspaceId: 'workspace', peonId: 'peon')
          .first;
      expect(projects, isEmpty);
      expect(await repository.cursorFor('workspace'), 5);
    },
  );

  test('a tombstone prevents an older REST row from reappearing', () async {
    await repository.applyLiveProjection(
      workspaceId: 'workspace',
      cursor: 7,
      projection: {
        'peonId': 'peon',
        'projectId': 'project-1',
        'deleted': true,
        'syncedAt': 70,
      },
    );

    final dio = Dio();
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) => handler.resolve(
          Response<Map<String, dynamic>>(
            requestOptions: options,
            data: {
              'projects': [
                {
                  'projectId': 'project-1',
                  'key': 'stale-project',
                  'syncedAt': 60,
                },
              ],
              'catalog': {'state': 'ready', 'stale': false},
            },
          ),
        ),
      ),
    );
    repository = DefaultProjectRepository(
      database: database,
      apiUrl: Uri.parse('https://overseer.example/api/'),
      token: 'test-token',
      dio: dio,
    );
    await repository.refreshProjects(workspaceId: 'workspace', peonId: 'peon');

    expect(
      await repository.loadCachedProjects(
        workspaceId: 'workspace',
        peonId: 'peon',
      ),
      isEmpty,
    );
  });
}
