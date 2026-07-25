import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/projects/application/projects_controller.dart';
import 'package:overseer_mobile/features/projects/domain/project_detail_models.dart';
import 'package:overseer_mobile/features/projects/domain/project_models.dart';
import 'package:overseer_mobile/features/projects/domain/project_repository.dart';
import 'package:overseer_mobile/features/projects/presentation/project_files_page.dart';
import 'package:overseer_mobile/shared/design/theme.dart';

void main() {
  testWidgets('shows the project tree and lazily expands directories', (
    tester,
  ) async {
    final repository = _FilesRepository({
      '': const [
        ProjectFileEntry(name: 'lib', type: 'dir'),
        ProjectFileEntry(name: 'README.md', type: 'file', size: 1536),
      ],
      'lib': const [
        ProjectFileEntry(name: 'main.dart', type: 'file', size: 800),
      ],
    });
    await tester.pumpWidget(
      ProviderScope(
        overrides: [projectRepositoryProvider.overrideWithValue(repository)],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const ProjectFilesPage(
            workspaceId: 'workspace',
            peonId: 'peon',
            projectKey: 'overseer-mobile',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('project-file-tree')), findsOneWidget);
    expect(find.text('lib'), findsOneWidget);
    expect(find.text('README.md'), findsOneWidget);
    expect(find.text('2 KB'), findsOneWidget);
    expect(find.text('main.dart'), findsNothing);
    expect(
      tester
          .getSize(find.byKey(const ValueKey('project-file-README.md')))
          .height,
      34,
    );

    await tester.tap(find.text('lib'));
    await tester.pumpAndSettle();

    expect(find.text('main.dart'), findsOneWidget);
    expect(repository.paths, ['', 'lib']);
    expect(find.bySemanticsLabel(RegExp(r'^Collapse lib')), findsOneWidget);
  });

  testWidgets('shows a truthful state when the session has no project', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: const ProjectFilesPage(
          workspaceId: 'workspace',
          peonId: 'peon',
          projectKey: null,
        ),
      ),
    );

    expect(find.text('No project files'), findsOneWidget);
    expect(find.byKey(const Key('project-files-refresh')), findsNothing);
  });

  testWidgets('opens Markdown with Mermaid and switches to code mode', (
    tester,
  ) async {
    final repository = _FilesRepository({
      '': const [ProjectFileEntry(name: 'README.md', type: 'file', size: 120)],
    });
    await tester.pumpWidget(
      ProviderScope(
        overrides: [projectRepositoryProvider.overrideWithValue(repository)],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const ProjectFilesPage(
            workspaceId: 'workspace',
            peonId: 'peon',
            projectKey: 'overseer-mobile',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('README.md'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('project-file-viewer-page')), findsOneWidget);
    expect(find.byKey(const Key('file-view-markdown-preview')), findsOneWidget);
    expect(find.byKey(const Key('file-view-mermaid-diagram')), findsOneWidget);

    await tester.tap(find.text('Code'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('file-view-code-preview')), findsOneWidget);
    expect(repository.openedPaths, ['README.md']);
  });

  testWidgets('keeps HTML code mode available without an embedded browser', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.linux;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    final repository = _FilesRepository({
      '': const [ProjectFileEntry(name: 'index.html', type: 'file', size: 50)],
    });
    await tester.pumpWidget(
      ProviderScope(
        overrides: [projectRepositoryProvider.overrideWithValue(repository)],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const ProjectFilesPage(
            workspaceId: 'workspace',
            peonId: 'peon',
            projectKey: 'overseer-mobile',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('index.html'));
    await tester.pumpAndSettle();

    expect(
      find.byKey(const Key('file-view-html-preview-unavailable')),
      findsOneWidget,
    );
    await tester.tap(find.text('Code'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('file-view-code-preview')), findsOneWidget);
    debugDefaultTargetPlatformOverride = null;
  });
}

class _FilesRepository implements ProjectRepository {
  _FilesRepository(this.directories);

  final Map<String, List<ProjectFileEntry>> directories;
  final List<String> paths = [];
  final List<String> openedPaths = [];

  @override
  Future<ProjectDirectory> fetchDirectory({
    required String workspaceId,
    required String peonId,
    required String projectKey,
    required String path,
  }) async {
    paths.add(path);
    return ProjectDirectory(path: path, entries: directories[path] ?? const []);
  }

  @override
  Future<ProjectFilePreview> fetchFile({
    required String workspaceId,
    required String peonId,
    required String projectKey,
    required String path,
  }) async {
    openedPaths.add(path);
    final source = path.endsWith('.html')
        ? '<h1>Project preview</h1>'
        : '# Project\n\n```mermaid\ngraph TD\n  A[Open] --> B[Preview]\n```';
    return ProjectFilePreview(
      path: path,
      bytes: Uint8List.fromList(utf8.encode(source)),
      contentType: path.endsWith('.html') ? 'text/html' : 'text/markdown',
    );
  }

  @override
  Future<List<PeonProject>> loadCachedProjects({
    required String workspaceId,
    required String peonId,
  }) async => const [];

  @override
  Stream<List<PeonProject>> watchProjects({
    required String workspaceId,
    required String peonId,
  }) => const Stream.empty();

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
  }) async => const ProjectSuggestion();

  @override
  Future<void> createProject({
    required String workspaceId,
    required String peonId,
    required String label,
    String? dir,
    String? metadata,
  }) async {}

  @override
  Future<void> advanceCursor({
    required String workspaceId,
    required int cursor,
  }) async {}

  @override
  Future<void> applyLiveProjection({
    required String workspaceId,
    required int cursor,
    required Map<String, dynamic> projection,
  }) async {}

  @override
  Future<int> cursorFor(String workspaceId) async => 0;
}
