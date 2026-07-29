import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/projects/application/projects_controller.dart';
import 'package:overseer_mobile/features/projects/domain/project_detail_models.dart';
import 'package:overseer_mobile/features/projects/domain/project_models.dart';
import 'package:overseer_mobile/features/projects/domain/project_repository.dart';
import 'package:overseer_mobile/features/projects/presentation/new_project_page.dart';
import 'package:overseer_mobile/shared/design/theme.dart';

void main() {
  const scope = ProjectsScope(workspaceId: 'workspace', peonId: 'peon');

  testWidgets('copies the web fields and debounced suggestion behavior', (
    tester,
  ) async {
    final repository = _ProjectFormRepository();
    await _pumpLauncher(tester, repository, scope);

    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('new-project-page')), findsOneWidget);
    expect(find.byKey(const Key('new-project-back')), findsOneWidget);
    expect(find.text('New project'), findsOneWidget);
    expect(find.text('LABEL'), findsOneWidget);
    expect(find.text('DIRECTORY'), findsOneWidget);
    expect(find.text('METADATA'), findsOneWidget);
    final create = tester.widget<TextButton>(
      find.descendant(
        of: find.byKey(const Key('create-new-project')),
        matching: find.byType(TextButton),
      ),
    );
    expect(create.onPressed, isNull);

    await tester.enterText(
      find.descendant(
        of: find.byKey(const Key('new-project-label')),
        matching: find.byType(TextField),
      ),
      'Overseer Mobile',
    );
    await tester.pump(const Duration(milliseconds: 349));
    expect(repository.suggestedLabels, isEmpty);
    await tester.pump(const Duration(milliseconds: 1));
    await tester.pump();

    expect(repository.suggestedLabels, ['Overseer Mobile']);
    expect(find.text('key: overseer-mobile'), findsOneWidget);
    expect(find.text('/projects/overseer-mobile'), findsOneWidget);
  });

  testWidgets('keeps a touched directory and submits trimmed web payload', (
    tester,
  ) async {
    final repository = _ProjectFormRepository();
    await _pumpLauncher(tester, repository, scope);
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.descendant(
        of: find.byKey(const Key('new-project-dir')),
        matching: find.byType(TextField),
      ),
      '/custom/project',
    );
    await tester.enterText(
      find.descendant(
        of: find.byKey(const Key('new-project-label')),
        matching: find.byType(TextField),
      ),
      '  Overseer Mobile  ',
    );
    await tester.pump(const Duration(milliseconds: 350));
    await tester.pump();
    expect(find.text('/custom/project'), findsOneWidget);

    await tester.enterText(
      find.descendant(
        of: find.byKey(const Key('new-project-metadata')),
        matching: find.byType(TextField),
      ),
      '# Mobile',
    );
    await tester.tap(find.byKey(const Key('create-new-project')));
    await tester.pumpAndSettle();

    expect(repository.createdLabel, 'Overseer Mobile');
    expect(repository.createdDir, '/custom/project');
    expect(repository.createdMetadata, '# Mobile');
    expect(find.text('New project'), findsNothing);
  });

  testWidgets('shows the web duplicate-project error and stays open', (
    tester,
  ) async {
    final repository = _ProjectFormRepository(
      createError: const ProjectsException(
        'raw message',
        code: 'PROJECT_EXISTS',
      ),
    );
    await _pumpLauncher(tester, repository, scope);
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.descendant(
        of: find.byKey(const Key('new-project-label')),
        matching: find.byType(TextField),
      ),
      'Existing',
    );
    await tester.pump();

    await tester.ensureVisible(find.byKey(const Key('create-new-project')));
    await tester.tap(find.text('Create'));
    await tester.pump();

    expect(repository.createCalls, 1);
    final error = tester.widget<Text>(
      find.byKey(const Key('new-project-error')),
    );
    expect(error.data, '⚠ A project with that key already exists.');
    expect(find.text('New project'), findsOneWidget);
  });
}

Future<void> _pumpLauncher(
  WidgetTester tester,
  ProjectRepository repository,
  ProjectsScope scope,
) async {
  await tester.binding.setSurfaceSize(const Size(430, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    ProviderScope(
      overrides: [projectRepositoryProvider.overrideWithValue(repository)],
      child: MaterialApp(
        theme: AppTheme.dark,
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => NewProjectPage(scope: scope),
                  ),
                ),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

class _ProjectFormRepository implements ProjectRepository {
  _ProjectFormRepository({this.createError});

  final ProjectsException? createError;
  final _projects = StreamController<List<PeonProject>>.broadcast();
  final List<String> suggestedLabels = [];
  String? createdLabel;
  String? createdDir;
  String? createdMetadata;
  var createCalls = 0;

  @override
  Future<List<PeonProject>> loadCachedProjects({
    required String workspaceId,
    required String peonId,
  }) async => const [];

  @override
  Stream<List<PeonProject>> watchProjects({
    required String workspaceId,
    required String peonId,
  }) => _projects.stream;

  @override
  Future<ProjectSnapshot> refreshProjects({
    required String workspaceId,
    required String peonId,
  }) async => const ProjectSnapshot(
    projects: [],
    catalog: ProjectCatalog(state: 'ready', stale: false),
  );

  @override
  Future<ProjectSuggestion> suggestProject({
    required String workspaceId,
    required String peonId,
    required String label,
  }) async {
    suggestedLabels.add(label);
    return const ProjectSuggestion(
      key: 'overseer-mobile',
      dir: '/projects/overseer-mobile',
    );
  }

  @override
  Future<void> createProject({
    required String workspaceId,
    required String peonId,
    required String label,
    String? dir,
    String? metadata,
  }) async {
    createCalls += 1;
    if (createError case final error?) throw error;
    createdLabel = label;
    createdDir = dir;
    createdMetadata = metadata;
  }

  @override
  Future<ProjectDirectory> fetchDirectory({
    required String workspaceId,
    required String peonId,
    required String projectKey,
    required String path,
  }) async => ProjectDirectory(path: path, entries: const []);

  @override
  Future<ProjectFilePreview> fetchFile({
    required String workspaceId,
    required String peonId,
    required String projectKey,
    required String path,
  }) => throw UnimplementedError();

  @override
  Future<void> applyLiveProjection({
    required String workspaceId,
    required int cursor,
    required Map<String, dynamic> projection,
  }) async {}

  @override
  Future<void> advanceCursor({
    required String workspaceId,
    required int cursor,
  }) async {}

  @override
  Future<int> cursorFor(String workspaceId) async => 0;
}
