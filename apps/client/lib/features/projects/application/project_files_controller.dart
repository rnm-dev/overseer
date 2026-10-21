import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/project_file_transfer_repository.dart';
import '../domain/project_models.dart';
import 'projects_controller.dart';

final projectFileTransfersProvider = Provider<ProjectFileTransferRepository>(
  (ref) => throw StateError(
    'ProjectFileTransferRepository must be supplied by the application '
    'composition root.',
  ),
);

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

/// A file the operator picked, described without tying the controller to a
/// platform picker: a name, its size and a way to read it once.
class ProjectUploadSource {
  const ProjectUploadSource({
    required this.name,
    required this.length,
    required this.open,
  });

  final String name;
  final int length;
  final Stream<List<int>> Function() open;
}

/// A row the tree draws before the bytes exist, so an upload lands visibly
/// where it will live and fills its ring in place of an icon.
class ProjectPendingUpload {
  const ProjectPendingUpload({
    required this.id,
    required this.parent,
    required this.name,
    required this.total,
    this.sent = 0,
  });

  final int id;
  final String parent;
  final String name;
  final int total;
  final int sent;

  double get progress => total <= 0 ? 0 : (sent / total).clamp(0, 1);

  ProjectPendingUpload withSent(int value) => ProjectPendingUpload(
    id: id,
    parent: parent,
    name: name,
    total: total,
    sent: value,
  );
}

class ProjectUploadResult {
  const ProjectUploadResult({required this.uploaded, required this.failures});

  final int uploaded;
  final List<String> failures;
}

class ProjectFilesState {
  const ProjectFilesState({
    required this.directories,
    this.expanded = const {''},
    this.refreshing = false,
    this.uploads = const [],
    this.moving = const {},
  });

  final Map<String, ProjectDirectoryState> directories;
  final Set<String> expanded;
  final bool refreshing;
  final List<ProjectPendingUpload> uploads;
  final Set<String> moving;

  ProjectFilesState copyWith({
    Map<String, ProjectDirectoryState>? directories,
    Set<String>? expanded,
    bool? refreshing,
    List<ProjectPendingUpload>? uploads,
    Set<String>? moving,
  }) {
    return ProjectFilesState(
      directories: directories ?? this.directories,
      expanded: expanded ?? this.expanded,
      refreshing: refreshing ?? this.refreshing,
      uploads: uploads ?? this.uploads,
      moving: moving ?? this.moving,
    );
  }
}

String projectParentPath(String path) {
  final index = path.lastIndexOf('/');
  return index < 0 ? '' : path.substring(0, index);
}

String projectBaseName(String path) =>
    path.substring(path.lastIndexOf('/') + 1);

String projectJoinPath(String parent, String name) =>
    parent.isEmpty ? name : '$parent/$name';

/// A name from the device is never trusted as a path: separators and NULs
/// fold away so a picked file can only land in the folder it was aimed at.
String projectSafeSegment(String name) {
  final cleaned = name.replaceAll(RegExp(r'[\\/\x00]'), '_');
  return cleaned.isEmpty || cleaned == '.' || cleaned == '..'
      ? 'file'
      : cleaned;
}

/// Why [source] cannot move into [targetDir], or null when it can.
String? projectMoveRefusal(String source, String targetDir) {
  if (projectParentPath(source) == targetDir) return 'Already in this folder.';
  if (targetDir == source || targetDir.startsWith('$source/')) {
    return 'A folder cannot move into itself.';
  }
  return null;
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

  int _nextUploadId = 0;

  /// Uploads [files] into [parent] one after another and reveals them there.
  Future<ProjectUploadResult> upload(
    String parent,
    List<ProjectUploadSource> files,
  ) async {
    final current = state.value;
    if (current == null || files.isEmpty) {
      return const ProjectUploadResult(uploaded: 0, failures: []);
    }
    final pending = [
      for (final file in files)
        ProjectPendingUpload(
          id: _nextUploadId++,
          parent: parent,
          name: projectSafeSegment(file.name),
          total: file.length,
        ),
    ];
    state = AsyncData(
      current.copyWith(uploads: [...current.uploads, ...pending]),
    );
    if (parent.isNotEmpty) await _reveal(parent);

    var uploaded = 0;
    final failures = <String>[];
    final transfers = ref.read(projectFileTransfersProvider);
    for (var index = 0; index < files.length; index++) {
      final file = files[index];
      final row = pending[index];
      try {
        await transfers.upload(
          workspaceId: scope.workspaceId,
          peonId: scope.peonId,
          projectKey: scope.projectKey,
          path: projectJoinPath(parent, row.name),
          bytes: file.open(),
          length: file.length,
          onProgress: (sent, _) => _updateUpload(row.id, sent),
        );
        uploaded++;
      } on ProjectsException catch (error) {
        failures.add('${row.name}: ${error.message}');
      } catch (_) {
        failures.add('${row.name}: could not be read.');
      }
      // Reload before dropping the ghost so the real row replaces it in place.
      await _loadDirectory(parent, preserveEntriesOnFailure: true);
      final latest = state.value;
      if (latest != null) {
        state = AsyncData(
          latest.copyWith(
            uploads: latest.uploads.where((u) => u.id != row.id).toList(),
          ),
        );
      }
    }
    return ProjectUploadResult(uploaded: uploaded, failures: failures);
  }

  /// Moves [source] into [targetDir], keeping the tree open where it was.
  Future<void> move(String source, String targetDir) async {
    final current = state.value;
    if (current == null) return;
    final refusal = projectMoveRefusal(source, targetDir);
    if (refusal != null) throw ProjectsException(refusal);
    final destination = projectJoinPath(targetDir, projectBaseName(source));
    state = AsyncData(current.copyWith(moving: {...current.moving, source}));
    try {
      await ref
          .read(projectFileTransfersProvider)
          .move(
            workspaceId: scope.workspaceId,
            peonId: scope.peonId,
            projectKey: scope.projectKey,
            source: source,
            destination: destination,
          );
      final latest = state.value;
      if (latest != null) {
        // A moved folder carries its open subfolders along with it.
        String remap(String path) =>
            path == source || path.startsWith('$source/')
            ? destination + path.substring(source.length)
            : path;
        state = AsyncData(
          latest.copyWith(
            expanded: latest.expanded.map(remap).toSet(),
            directories: {
              for (final entry in latest.directories.entries)
                if (entry.key != source && !entry.key.startsWith('$source/'))
                  entry.key: entry.value,
            },
          ),
        );
      }
      await _loadDirectory(
        projectParentPath(source),
        preserveEntriesOnFailure: true,
      );
      if (targetDir.isNotEmpty) await _reveal(targetDir);
      await _loadDirectory(targetDir, preserveEntriesOnFailure: true);
      for (final path in state.value?.expanded ?? const <String>{}) {
        if (path.startsWith('$destination/') || path == destination) {
          await _loadDirectory(path, preserveEntriesOnFailure: true);
        }
      }
    } finally {
      final latest = state.value;
      if (latest != null) {
        state = AsyncData(
          latest.copyWith(moving: {...latest.moving}..remove(source)),
        );
      }
    }
  }

  /// Opens [path] and its ancestors so a result is visible where it landed.
  Future<void> _reveal(String path) async {
    final segments = path.split('/');
    for (var i = 1; i <= segments.length; i++) {
      final ancestor = segments.take(i).join('/');
      final current = state.value;
      if (current == null) return;
      if (!current.expanded.contains(ancestor)) {
        await toggleDirectory(ancestor);
      }
    }
  }

  void _updateUpload(int id, int sent) {
    final current = state.value;
    if (current == null) return;
    state = AsyncData(
      current.copyWith(
        uploads: [
          for (final upload in current.uploads)
            upload.id == id ? upload.withSent(sent) : upload,
        ],
      ),
    );
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
