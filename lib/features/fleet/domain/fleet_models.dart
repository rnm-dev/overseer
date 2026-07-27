class Workspace {
  const Workspace({required this.id, required this.name, this.role});

  final String id;
  final String name;
  final String? role;
}

class PeonLoad {
  const PeonLoad({this.activeSessions, this.paused});

  final int? activeSessions;
  final bool? paused;
}

class Peon {
  const Peon({
    required this.id,
    required this.online,
    required this.lastSeen,
    required this.capabilities,
    this.name,
    this.hostname,
    this.baseUrl,
    this.addressSource,
    this.load,
    this.recentSessions = const [],
  });

  final String id;
  final String? name;
  final String? hostname;
  final String? baseUrl;
  final String? addressSource;
  final bool online;
  final double lastSeen;
  final List<String> capabilities;
  final PeonLoad? load;
  final List<FleetRecentSession> recentSessions;

  String get displayName {
    final candidate = name?.trim().isNotEmpty == true ? name : hostname;
    return candidate?.trim().isNotEmpty == true
        ? candidate!.trim()
        : 'Unnamed peon';
  }

  int get activeSessions => load?.activeSessions ?? 0;
}

class FleetRecentSession {
  const FleetRecentSession({
    required this.workspaceId,
    required this.peonId,
    required this.sessionId,
    required this.syncedAt,
    required this.attentionUpdatedAt,
    required this.hasOutstandingRequest,
    required this.attentionUnread,
    this.status,
    this.projectKey,
    this.projectId,
    this.title,
    this.promptPreview,
    this.preview,
    this.startedAt,
    this.lastActivityAt,
    this.lastRequestedAt,
  });

  final String workspaceId;
  final String peonId;
  final String sessionId;
  final String? status;
  final String? projectKey;
  final String? projectId;
  final String? title;
  final String? promptPreview;
  final String? preview;
  final double? startedAt;
  final double? lastActivityAt;
  final double syncedAt;
  final double attentionUpdatedAt;
  final bool hasOutstandingRequest;
  final bool attentionUnread;
  final double? lastRequestedAt;

  double get sortActivity => lastActivityAt ?? startedAt ?? 0;

  String get displayTitle {
    for (final candidate in [title, promptPreview, preview]) {
      final value = candidate?.trim();
      if (value != null && value.isNotEmpty) return value;
    }
    return 'Untitled session';
  }
}

class WorkspaceFleet {
  const WorkspaceFleet({required this.workspace, required this.peons});

  final Workspace workspace;
  final List<Peon> peons;
}
