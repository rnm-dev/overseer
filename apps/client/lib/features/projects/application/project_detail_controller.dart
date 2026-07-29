import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/project_detail_models.dart';
import '../domain/project_detail_repository.dart';
import '../domain/project_models.dart';

final projectDetailRepositoryProvider = Provider<ProjectDetailRepository>(
  (ref) => throw StateError(
    'ProjectDetailRepository must be supplied by the composition root.',
  ),
);

final projectDetailControllerProvider = AsyncNotifierProvider.autoDispose
    .family<ProjectDetailController, ProjectDetailState, ProjectDetailScope>(
      ProjectDetailController.new,
      retry: (_, _) => null,
    );

class ProjectDetailScope {
  const ProjectDetailScope({
    required this.project,
    required this.online,
    required this.isOwner,
  });

  final PeonProject project;
  final bool online;
  final bool isOwner;

  @override
  bool operator ==(Object other) =>
      other is ProjectDetailScope &&
      other.project.workspaceId == project.workspaceId &&
      other.project.peonId == project.peonId &&
      other.project.projectId == project.projectId &&
      other.online == online &&
      other.isOwner == isOwner;

  @override
  int get hashCode => Object.hash(
    project.workspaceId,
    project.peonId,
    project.projectId,
    online,
    isOwner,
  );
}

class ProjectDetailController extends AsyncNotifier<ProjectDetailState> {
  ProjectDetailController(this.scope);

  final ProjectDetailScope scope;

  ProjectDetailRepository get _repository =>
      ref.read(projectDetailRepositoryProvider);

  @override
  Future<ProjectDetailState> build() async {
    final initial = ProjectDetailState(project: scope.project);
    if (!scope.online) return initial;
    Future<void>(() => refreshOverview());
    return initial;
  }

  Future<void> refreshOverview() async {
    final current = state.value;
    if (current == null || current.loading || !scope.online) return;
    state = AsyncData(
      current.copyWith(loading: true, clearMessage: true, saved: false),
    );
    try {
      final project = await _repository.fetchProject(
        workspaceId: current.project.workspaceId,
        peonId: current.project.peonId,
        projectKey: current.project.key,
      );
      final listing = await _repository.fetchDocumentation(
        workspaceId: project.workspaceId,
        peonId: project.peonId,
        projectId: project.projectId,
      );
      var next = (state.value ?? current).copyWith(
        project: project,
        documentation: listing,
        loading: false,
        clearMessage: true,
        clearDocumentationSource: true,
      );
      final index = listing.entries
          .where((entry) => !entry.isDirectory && entry.name == 'index.md')
          .firstOrNull;
      state = AsyncData(next);
      if (listing.exists && index != null) {
        await openDocumentation('docs/index.md');
        next = state.value ?? next;
      }
      state = AsyncData(next.copyWith(loading: false));
    } on ProjectsException catch (error) {
      final latest = state.value ?? current;
      state = AsyncData(
        latest.copyWith(
          loading: false,
          message: error.message,
          code: error.code,
        ),
      );
    }
  }

  Future<void> openDocumentation(String path) async {
    final current = state.value;
    if (current == null || current.loading) return;
    state = AsyncData(
      current.copyWith(
        loading: true,
        documentationPath: path,
        clearMessage: true,
      ),
    );
    try {
      final file = await _repository.fetchFile(
        workspaceId: current.project.workspaceId,
        peonId: current.project.peonId,
        projectId: current.project.projectId,
        path: path,
      );
      if (file.bytes.length > 512 * 1024) {
        throw const ProjectsException(
          'Documentation index is too large to preview.',
          code: 'DOCS_TOO_LARGE',
        );
      }
      state = AsyncData(
        (state.value ?? current).copyWith(
          loading: false,
          documentationPath: path,
          documentationSource: utf8.decode(file.bytes, allowMalformed: true),
          clearMessage: true,
        ),
      );
    } on ProjectsException catch (error) {
      state = AsyncData(
        (state.value ?? current).copyWith(
          loading: false,
          message: error.message,
          code: error.code,
        ),
      );
    }
  }

  Future<void> loadSkills() async {
    final current = state.value;
    if (current == null || current.skills != null || current.loading) return;
    await _load(
      () async => current.copyWith(
        skills: await _repository.fetchSkills(
          workspaceId: current.project.workspaceId,
          peonId: current.project.peonId,
          projectKey: current.project.key,
        ),
      ),
    );
  }

  Future<void> loadMembers() async {
    final current = state.value;
    if (current == null ||
        current.members != null ||
        current.loading ||
        !scope.isOwner) {
      return;
    }
    await _load(
      () async => current.copyWith(
        members: await _repository.fetchMembers(
          workspaceId: current.project.workspaceId,
        ),
      ),
    );
  }

  Future<void> loadSettings() async {
    final current = state.value;
    if (current == null ||
        current.settings != null ||
        current.loading ||
        !scope.isOwner) {
      return;
    }
    await _load(
      () async => current.copyWith(
        settings: await _repository.fetchSettings(
          workspaceId: current.project.workspaceId,
          peonId: current.project.peonId,
          projectKey: current.project.key,
        ),
      ),
    );
  }

  Future<void> loadSettingsHub() async {
    await loadSettings();
    await loadSkills();
    await loadMembers();
  }

  Future<void> openFile(String path) async {
    final current = state.value;
    if (current == null || current.loading || !scope.online) return;
    state = AsyncData(
      current.copyWith(loading: true, clearMessage: true, saved: false),
    );
    try {
      final preview = await _repository.fetchFile(
        workspaceId: current.project.workspaceId,
        peonId: current.project.peonId,
        projectId: current.project.projectId,
        path: path,
      );
      state = AsyncData(
        (state.value ?? current).copyWith(
          filePreview: preview,
          loading: false,
          clearMessage: true,
        ),
      );
    } on ProjectsException catch (error) {
      state = AsyncData(
        (state.value ?? current).copyWith(
          loading: false,
          message: error.message,
          code: error.code,
        ),
      );
    }
  }

  Future<void> saveSettings(ProjectSettings settings) async {
    final current = state.value;
    if (current == null || current.saving || !scope.online) return;
    state = AsyncData(
      current.copyWith(saving: true, saved: false, clearMessage: true),
    );
    try {
      final updated = await _repository.updateSettings(
        workspaceId: current.project.workspaceId,
        peonId: current.project.peonId,
        projectKey: current.project.key,
        settings: settings,
      );
      final project = PeonProject(
        workspaceId: current.project.workspaceId,
        peonId: current.project.peonId,
        projectId: updated.projectId ?? current.project.projectId,
        key: updated.key,
        name: updated.name,
        dir: updated.dir,
        metadata: updated.metadata,
        sessionCount: current.project.sessionCount,
        memberCount: current.project.memberCount,
        activeCount: current.project.activeCount,
        lastActivityMs: current.project.lastActivityMs,
        syncedAt: current.project.syncedAt,
      );
      state = AsyncData(
        (state.value ?? current).copyWith(
          project: project,
          settings: updated,
          saving: false,
          saved: true,
          clearMessage: true,
        ),
      );
    } on ProjectsException catch (error) {
      state = AsyncData(
        (state.value ?? current).copyWith(
          saving: false,
          saved: false,
          message: error.message,
          code: error.code,
        ),
      );
    }
  }

  Future<void> setMemberAccess(WorkspaceMember member, bool enabled) async {
    final current = state.value;
    final snapshot = current?.members;
    final access = snapshot?.accessByMember[member.userId];
    if (current == null || snapshot == null || access == null) return;
    final filtered = access.projects.where((item) {
      if (item.peonId != current.project.peonId) return true;
      return current.project.projectId.isNotEmpty
          ? item.projectId != current.project.projectId
          : item.projectKey != current.project.key;
    }).toList();
    final next = MemberAccess(
      peonIds: enabled
          ? {...access.peonIds, current.project.peonId}.toList()
          : access.peonIds,
      projects: enabled
          ? [
              ...filtered,
              ProjectAccessReference(
                peonId: current.project.peonId,
                projectKey: current.project.key,
                projectId: current.project.projectId,
              ),
            ]
          : filtered,
    );
    state = AsyncData(
      current.copyWith(saving: true, saved: false, clearMessage: true),
    );
    try {
      await _repository.updateMemberAccess(
        workspaceId: current.project.workspaceId,
        userId: member.userId,
        access: next,
      );
      state = AsyncData(
        (state.value ?? current).copyWith(
          members: ProjectMembersSnapshot(
            members: snapshot.members,
            accessByMember: {...snapshot.accessByMember, member.userId: next},
          ),
          saving: false,
          saved: true,
        ),
      );
    } on ProjectsException catch (error) {
      state = AsyncData(
        current.copyWith(
          saving: false,
          message: error.message,
          code: error.code,
        ),
      );
    }
  }

  Future<void> _load(Future<ProjectDetailState> Function() work) async {
    final current = state.value;
    if (current == null || !scope.online) return;
    state = AsyncData(
      current.copyWith(loading: true, clearMessage: true, saved: false),
    );
    try {
      state = AsyncData(
        (await work()).copyWith(loading: false, clearMessage: true),
      );
    } on ProjectsException catch (error) {
      state = AsyncData(
        (state.value ?? current).copyWith(
          loading: false,
          message: error.message,
          code: error.code,
        ),
      );
    }
  }
}
