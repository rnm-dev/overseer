import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/projects/application/project_detail_controller.dart';
import 'package:overseer_mobile/features/projects/domain/project_detail_models.dart';
import 'package:overseer_mobile/features/projects/domain/project_detail_repository.dart';
import 'package:overseer_mobile/features/projects/domain/project_models.dart';
import 'package:overseer_mobile/features/projects/presentation/project_detail_page.dart';

void main() {
  const project = PeonProject(
    workspaceId: 'workspace',
    peonId: 'peon',
    projectId: 'project-id',
    key: 'overseer-mobile',
    name: 'Overseer Mobile',
    syncedAt: 1,
  );

  testWidgets('opens sessions first and loads every owner tab', (tester) async {
    final repository = _FakeProjectDetailRepository(project);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          projectDetailRepositoryProvider.overrideWithValue(repository),
        ],
        child: const MaterialApp(
          home: ProjectDetailPage(
            workspaceId: 'workspace',
            peonId: 'peon',
            project: project,
            online: true,
            isOwner: true,
          ),
        ),
      ),
    );
    expect(find.text('Overseer Mobile'), findsOneWidget);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('project-sessions-pane')), findsOneWidget);
    expect(
      tester.getTopLeft(find.byKey(const Key('project-tab-sessions'))).dx,
      lessThan(
        tester.getTopLeft(find.byKey(const Key('project-tab-overview'))).dx,
      ),
    );
    expect(find.text('Documents'), findsOneWidget);
    await tester.tap(find.byKey(const Key('project-tab-overview')));
    await tester.pump();
    expect(find.text('Project  ›  docs'), findsOneWidget);
    expect(find.byType(CustomScrollView), findsOneWidget);
    expect(find.byKey(const Key('project-overview-path-blur')), findsOneWidget);
    expect(find.byKey(const Key('project-docs-refresh')), findsOneWidget);
    expect(repository.fileFetches, 1);
    expect(find.byKey(const Key('project-tab-sessions')), findsOneWidget);
    expect(find.byKey(const Key('project-tab-skills')), findsNothing);
    expect(find.byKey(const Key('project-tab-members')), findsNothing);

    await tester.tap(find.byKey(const Key('project-tab-sessions')));
    await tester.pump();
    expect(find.byKey(const Key('project-sessions-pane')), findsOneWidget);
    expect(find.text('SESSIONS'), findsNothing);

    await tester.tap(find.byKey(const Key('project-tab-files')));
    await tester.pump();
    expect(find.byKey(const Key('project-files-pane')), findsOneWidget);
    expect(find.byKey(const Key('project-files-tab-refresh')), findsOneWidget);

    await tester.tap(find.byKey(const Key('project-tab-settings')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('project-settings-save')), findsOneWidget);
    expect(find.text('/projects/overseer-mobile'), findsOneWidget);

    await tester.tap(find.byKey(const Key('project-settings-section-skills')));
    await tester.pumpAndSettle();
    expect(find.text('mobile-review'), findsOneWidget);

    await tester.tap(find.byKey(const Key('project-settings-section-members')));
    await tester.pumpAndSettle();
    expect(find.text('@member'), findsOneWidget);
  });

  testWidgets('sessions pane is full bleed and new session opens the project', (
    tester,
  ) async {
    String? openedProjectKey;
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          projectDetailRepositoryProvider.overrideWithValue(
            _FakeProjectDetailRepository(project),
          ),
        ],
        child: MaterialApp(
          home: ProjectDetailPage(
            workspaceId: 'workspace',
            peonId: 'peon',
            project: project,
            online: true,
            isOwner: true,
            onNewSession:
                (
                  _, {
                  required workspaceId,
                  required peonId,
                  required projectKey,
                }) {
                  openedProjectKey = projectKey;
                },
            sessionListBuilder:
                (
                  _, {
                  required workspaceId,
                  required peonId,
                  required projectId,
                  required projectKey,
                }) => const SizedBox(
                  key: Key('project-session-list'),
                  height: 80,
                ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final newSession = find.byKey(const Key('project-new-session'));
    final newSessionButton = find.descendant(
      of: newSession,
      matching: find.byType(IconButton),
    );
    expect(tester.getSize(newSessionButton), const Size.square(44));
    expect(tester.widget<IconButton>(newSessionButton).tooltip, 'New session');
    await tester.tap(newSession);
    expect(openedProjectKey, 'overseer-mobile');

    await tester.tap(find.byKey(const Key('project-tab-sessions')));
    await tester.pump();
    expect(find.text('SESSIONS'), findsNothing);
    expect(
      tester.getTopLeft(find.byKey(const Key('project-session-list'))),
      tester.getTopLeft(find.byKey(const Key('project-sessions-pane'))),
    );
  });

  testWidgets('hides owner tabs and keeps cached content while offline', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          projectDetailRepositoryProvider.overrideWithValue(
            _FakeProjectDetailRepository(project),
          ),
        ],
        child: const MaterialApp(
          home: ProjectDetailPage(
            workspaceId: 'workspace',
            peonId: 'peon',
            project: project,
            online: false,
            isOwner: false,
          ),
        ),
      ),
    );
    await tester.pump();
    expect(find.text('Members'), findsNothing);
    expect(find.text('Settings'), findsOneWidget);
    expect(find.textContaining('Cached project details'), findsOneWidget);
    await tester.tap(find.byKey(const Key('project-tab-settings')));
    await tester.pump();
    expect(
      find.byKey(const Key('project-settings-section-skills')),
      findsOneWidget,
    );
    expect(
      find.byKey(const Key('project-settings-section-general')),
      findsNothing,
    );
    final newSessionButton = find.descendant(
      of: find.byKey(const Key('project-new-session')),
      matching: find.byType(IconButton),
    );
    expect(tester.widget<IconButton>(newSessionButton).onPressed, isNull);
  });

  testWidgets('opens external and relative links from project Markdown', (
    tester,
  ) async {
    final repository = _FakeProjectDetailRepository(project);
    final launched = <Uri>[];
    String? openedProjectFile;
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          projectDetailRepositoryProvider.overrideWithValue(repository),
        ],
        child: MaterialApp(
          home: ProjectDetailPage(
            workspaceId: 'workspace',
            peonId: 'peon',
            project: project,
            online: true,
            isOwner: true,
            linkLauncher: (uri) async {
              launched.add(uri);
              return true;
            },
            onOpenFile:
                (
                  _, {
                  required workspaceId,
                  required peonId,
                  required projectId,
                  required projectKey,
                  required path,
                }) {
                  openedProjectFile = path;
                },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('project-tab-overview')));
    await tester.pump();
    await tester.tap(find.text('Website'));
    await tester.pump();
    expect(launched, [Uri.parse('https://example.com')]);

    await tester.tap(find.text('Source'));
    await tester.pump();
    expect(openedProjectFile, 'lib/main.dart');

    await tester.tap(find.text('Architecture'));
    await tester.pumpAndSettle();
    expect(repository.fetchedPaths.last, 'docs/architecture.md');
    expect(find.text('Architecture details'), findsOneWidget);
  });
}

class _FakeProjectDetailRepository implements ProjectDetailRepository {
  _FakeProjectDetailRepository(this.project);

  final PeonProject project;
  int fileFetches = 0;
  final List<String> fetchedPaths = [];

  @override
  Future<PeonProject> fetchProject({
    required String workspaceId,
    required String peonId,
    required String projectKey,
  }) async => project;

  @override
  Future<ProjectDocumentationListing> fetchDocumentation({
    required String workspaceId,
    required String peonId,
    required String projectId,
  }) async => const ProjectDocumentationListing(
    exists: true,
    entries: [ProjectDocumentationEntry(name: 'index.md', type: 'file')],
  );

  @override
  Future<ProjectFilePreview> fetchFile({
    required String workspaceId,
    required String peonId,
    required String projectId,
    required String path,
  }) async {
    fileFetches++;
    fetchedPaths.add(path);
    return ProjectFilePreview(
      path: path,
      bytes: Uint8List.fromList(switch (path) {
        'docs/index.md' =>
          '''
# Project documentation

[Website](https://example.com)

[Architecture](architecture.md)

[Source](../lib/main.dart)
'''
              .codeUnits,
        'docs/architecture.md' => '# Architecture details'.codeUnits,
        _ => '# Project documentation'.codeUnits,
      }),
      contentType: 'text/markdown',
    );
  }

  @override
  Future<List<ProjectSkill>> fetchSkills({
    required String workspaceId,
    required String peonId,
    required String projectKey,
  }) async => const [
    ProjectSkill(
      name: 'mobile-review',
      description: 'Reviews the mobile interface.',
      path: '.agents/skills/mobile-review/SKILL.md',
    ),
  ];

  @override
  Future<ProjectMembersSnapshot> fetchMembers({
    required String workspaceId,
  }) async => const ProjectMembersSnapshot(
    members: [
      WorkspaceMember(
        userId: 'owner',
        email: 'owner@example.com',
        role: 'owner',
      ),
      WorkspaceMember(
        userId: 'member',
        email: 'member@example.com',
        role: 'member',
        githubLogin: 'member',
      ),
    ],
    accessByMember: {'member': MemberAccess(peonIds: [], projects: [])},
  );

  @override
  Future<ProjectSettings> fetchSettings({
    required String workspaceId,
    required String peonId,
    required String projectKey,
  }) async => const ProjectSettings(
    projectId: 'project-id',
    key: 'overseer-mobile',
    name: 'Overseer Mobile',
    dir: '/projects/overseer-mobile',
  );

  @override
  Future<ProjectSettings> updateSettings({
    required String workspaceId,
    required String peonId,
    required String projectKey,
    required ProjectSettings settings,
  }) async => settings;

  @override
  Future<MemberAccess> updateMemberAccess({
    required String workspaceId,
    required String userId,
    required MemberAccess access,
  }) async => access;
}
