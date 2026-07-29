import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/project_models.dart';
import 'projects_controller.dart';

final projectFilesControllerProvider = AsyncNotifierProvider.autoDispose
    .family<ProjectFilesController, ProjectFilesState, ProjectFilesScope>(
      ProjectFilesController.new,
      retry: (_, _) => null,
    );

class ProjectFilesScope {
  const ProjectFilesScope({
    required this.workspaceId,
    required this.peonId,
    required this.projectKey,
  });

  final String workspaceId;
  final String peonId;
  final String projectKey;

  @override
  bool operator ==(Object other) =>
      other is ProjectFilesScope &&
      other.workspaceId == workspaceId &&
      other.peonId == peonId &&
      other.projectKey == projectKey;

  @override
  int get hashCode => Object.hash(workspaceId, peonId, projectKey);
}

class ProjectDirectoryState {
  const ProjectDirectoryState({
    this.entries = const [],
    this.loading = false,
    this.message,
  });

  final List<ProjectFileEntry> entries;
  final bool loading;
  final String? message;
}

class ProjectFilesState {
  const ProjectFilesState({
    required this.directories,
    this.expanded = const {''},
    this.refreshing = false,
  });

  final Map<String, ProjectDirectoryState> directories;
  final Set<String> expanded;
  final bool refreshing;

  ProjectFilesState copyWith({
    Map<String, ProjectDirectoryState>? directories,
    Set<String>? expanded,
    bool? refreshing,
  }) {
    return ProjectFilesState(
      directories: directories ?? this.directories,
      expanded: expanded ?? this.expanded,
      refreshing: refreshing ?? this.refreshing,
    );
  }
}

class ProjectFilesController extends AsyncNotifier<ProjectFilesState> {
  ProjectFilesController(this.scope);

  final ProjectFilesScope scope;

  @override
  Future<ProjectFilesState> build() async {
    final root = await _fetch('');
    return ProjectFilesState(
      directories: {'': ProjectDirectoryState(entries: root.entries)},
    );
  }

  Future<void> toggleDirectory(String path) async {
    final current = state.value;
    if (current == null) return;
    if (current.expanded.contains(path)) {
      state = AsyncData(
        current.copyWith(expanded: {...current.expanded}..remove(path)),
      );
      return;
    }

    state = AsyncData(
      current.copyWith(
        expanded: {...current.expanded, path},
        directories: {
          ...current.directories,
          if (!current.directories.containsKey(path))
            path: const ProjectDirectoryState(loading: true),
        },
      ),
    );
    if (current.directories.containsKey(path)) return;
    await _loadDirectory(path);
  }

  Future<void> retryDirectory(String path) => _loadDirectory(path);

  Future<void> refresh() async {
    final current = state.value;
    if (current == null || current.refreshing) return;
    state = AsyncData(current.copyWith(refreshing: true));
    for (final path in current.expanded) {
      await _loadDirectory(path, preserveEntriesOnFailure: true);
    }
    final latest = state.value;
    if (latest != null) {
      state = AsyncData(latest.copyWith(refreshing: false));
    }
  }

  Future<void> _loadDirectory(
    String path, {
    bool preserveEntriesOnFailure = false,
  }) async {
    final current = state.value;
    if (current == null) return;
    final previous = current.directories[path];
    state = AsyncData(
      current.copyWith(
        directories: {
          ...current.directories,
          path: ProjectDirectoryState(
            entries: previous?.entries ?? const [],
            loading: true,
          ),
        },
      ),
    );
    try {
      final directory = await _fetch(path);
      final latest = state.value;
      if (latest == null) return;
      state = AsyncData(
        latest.copyWith(
          directories: {
            ...latest.directories,
            path: ProjectDirectoryState(entries: directory.entries),
          },
        ),
      );
    } on ProjectsException catch (error) {
      final latest = state.value;
      if (latest == null) return;
      state = AsyncData(
        latest.copyWith(
          directories: {
            ...latest.directories,
            path: ProjectDirectoryState(
              entries: preserveEntriesOnFailure
                  ? previous?.entries ?? const []
                  : const [],
              message: error.message,
            ),
          },
        ),
      );
    }
  }

  Future<ProjectDirectory> _fetch(String path) {
    return ref
        .read(projectRepositoryProvider)
        .fetchDirectory(
          workspaceId: scope.workspaceId,
          peonId: scope.peonId,
          projectKey: scope.projectKey,
          path: path,
        );
  }
}
