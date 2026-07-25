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

  String get displayName {
    final candidate = name?.trim().isNotEmpty == true ? name : hostname;
    return candidate?.trim().isNotEmpty == true
        ? candidate!.trim()
        : 'Unnamed peon';
  }

  int get activeSessions => load?.activeSessions ?? 0;
}

class WorkspaceFleet {
  const WorkspaceFleet({required this.workspace, required this.peons});

  final Workspace workspace;
  final List<Peon> peons;
}
