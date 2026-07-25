import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/project_models.dart';
import '../domain/project_repository.dart';

final projectRepositoryProvider = Provider<ProjectRepository>(
  (ref) => throw StateError(
    'ProjectRepository must be supplied by the application composition root.',
  ),
);

final projectsControllerProvider = AsyncNotifierProvider.autoDispose
    .family<ProjectsController, ProjectsState, ProjectsScope>(
      ProjectsController.new,
      retry: (_, _) => null,
    );

class ProjectsScope {
  const ProjectsScope({required this.workspaceId, required this.peonId});

  final String workspaceId;
  final String peonId;

  @override
  bool operator ==(Object other) =>
      other is ProjectsScope &&
      other.workspaceId == workspaceId &&
      other.peonId == peonId;

  @override
  int get hashCode => Object.hash(workspaceId, peonId);
}

class ProjectsState {
  const ProjectsState({
    required this.projects,
    this.isRefreshing = false,
    this.catalog,
    this.message,
  });

  final List<PeonProject> projects;
  final bool isRefreshing;
  final ProjectCatalog? catalog;
  final String? message;

  ProjectsState copyWith({
    List<PeonProject>? projects,
    bool? isRefreshing,
    ProjectCatalog? catalog,
    String? message,
    bool clearMessage = false,
  }) {
    return ProjectsState(
      projects: projects ?? this.projects,
      isRefreshing: isRefreshing ?? this.isRefreshing,
      catalog: catalog ?? this.catalog,
      message: clearMessage ? null : message ?? this.message,
    );
  }
}

class ProjectsController extends AsyncNotifier<ProjectsState> {
  ProjectsController(this.scope);

  final ProjectsScope scope;
  StreamSubscription<List<PeonProject>>? _subscription;

  ProjectRepository get _repository => ref.read(projectRepositoryProvider);

  @override
  Future<ProjectsState> build() async {
    final cached = await _repository.loadCachedProjects(
      workspaceId: scope.workspaceId,
      peonId: scope.peonId,
    );
    _subscription = _repository
        .watchProjects(workspaceId: scope.workspaceId, peonId: scope.peonId)
        .listen(_applyCachedProjects);
    ref.onDispose(() => unawaited(_subscription?.cancel()));
    Future<void>.microtask(refresh);
    return ProjectsState(projects: cached);
  }

  Future<void> refresh() async {
    if (!ref.mounted) return;
    final current = state.value;
    if (current == null || current.isRefreshing) return;
    state = AsyncData(current.copyWith(isRefreshing: true, clearMessage: true));
    try {
      final snapshot = await _repository.refreshProjects(
        workspaceId: scope.workspaceId,
        peonId: scope.peonId,
      );
      if (!ref.mounted) return;
      final latest = state.value ?? current;
      state = AsyncData(
        latest.copyWith(
          isRefreshing: false,
          catalog: snapshot.catalog,
          clearMessage: true,
        ),
      );
    } on ProjectsException catch (error) {
      if (!ref.mounted) return;
      final latest = state.value ?? current;
      state = AsyncData(
        latest.copyWith(isRefreshing: false, message: error.message),
      );
    }
  }

  Future<ProjectSuggestion> suggestProject(String label) {
    return _repository.suggestProject(
      workspaceId: scope.workspaceId,
      peonId: scope.peonId,
      label: label,
    );
  }

  Future<void> createProject({
    required String label,
    String? dir,
    String? metadata,
  }) async {
    await _repository.createProject(
      workspaceId: scope.workspaceId,
      peonId: scope.peonId,
      label: label,
      dir: dir,
      metadata: metadata,
    );
    await refresh();
  }

  void _applyCachedProjects(List<PeonProject> projects) {
    final current = state.value;
    if (current == null) return;
    state = AsyncData(current.copyWith(projects: projects));
  }
}
