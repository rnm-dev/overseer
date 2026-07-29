class PeonProject {
  const PeonProject({
    required this.workspaceId,
    required this.peonId,
    required this.projectId,
    required this.key,
    required this.syncedAt,
    this.name,
    this.dir,
    this.metadata,
    this.sessionCount = 0,
    this.memberCount = 0,
    this.activeCount = 0,
    this.lastActivityMs,
    this.deleted = false,
  });

  final String workspaceId;
  final String peonId;
  final String projectId;
  final String key;
  final String? name;
  final String? dir;
  final String? metadata;
  final int sessionCount;
  final int memberCount;
  final int activeCount;
  final double? lastActivityMs;
  final double syncedAt;
  final bool deleted;

  String get displayName {
    final candidate = name?.trim();
    return candidate?.isNotEmpty == true ? candidate! : key;
  }
}

class ProjectCatalog {
  const ProjectCatalog({
    required this.state,
    required this.stale,
    this.updatedAt,
  });

  final String state;
  final bool stale;
  final double? updatedAt;
}

class ProjectSnapshot {
  const ProjectSnapshot({required this.projects, required this.catalog});

  final List<PeonProject> projects;
  final ProjectCatalog catalog;
}

class ProjectSuggestion {
  const ProjectSuggestion({this.key, this.dir});

  final String? key;
  final String? dir;
}

class ProjectDirectory {
  const ProjectDirectory({required this.path, required this.entries});

  final String path;
  final List<ProjectFileEntry> entries;
}

class ProjectFileEntry {
  const ProjectFileEntry({
    required this.name,
    required this.type,
    this.size,
    this.mtimeMs,
  });

  final String name;
  final String type;
  final int? size;
  final double? mtimeMs;

  bool get isDirectory => type == 'dir' || type == 'directory';
}

class ProjectsException implements Exception {
  const ProjectsException(this.message, {this.code});

  final String message;
  final String? code;

  @override
  String toString() => message;
}
