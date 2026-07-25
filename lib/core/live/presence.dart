import 'package:flutter_riverpod/flutter_riverpod.dart';

final presenceProvider = NotifierProvider<PresenceController, PresenceState>(
  PresenceController.new,
);

enum PresenceScope { workspace, peon, session }

class PresenceLocation {
  const PresenceLocation.workspace()
    : scope = PresenceScope.workspace,
      peonId = null,
      sessionId = null;

  const PresenceLocation.peon({required this.peonId})
    : scope = PresenceScope.peon,
      sessionId = null;

  const PresenceLocation.session({
    required this.peonId,
    required this.sessionId,
  }) : scope = PresenceScope.session;

  final PresenceScope scope;
  final String? peonId;
  final String? sessionId;

  Map<String, Object> toJson() => {
    'type': 'presence:set',
    'scope': scope.name,
    ...switch (peonId) {
      final value? => {'peonId': value},
      null => const <String, Object>{},
    },
    ...switch (sessionId) {
      final value? => {'sessionId': value},
      null => const <String, Object>{},
    },
  };
}

class PresenceViewer {
  const PresenceViewer({
    required this.userId,
    required this.email,
    this.githubLogin,
    this.avatarUrl,
  });

  factory PresenceViewer.fromJson(Map<String, dynamic> json) {
    return PresenceViewer(
      userId: json['userId'] as String,
      email: json['email'] as String,
      githubLogin: json['githubLogin'] as String?,
      avatarUrl: json['avatarUrl'] as String?,
    );
  }

  final String userId;
  final String email;
  final String? githubLogin;
  final String? avatarUrl;

  String get displayName {
    final login = githubLogin?.trim();
    return login?.isNotEmpty == true ? login! : email;
  }
}

class PresenceEntry extends PresenceViewer {
  const PresenceEntry({
    required super.userId,
    required super.email,
    required this.scope,
    super.githubLogin,
    super.avatarUrl,
    this.peonId,
    this.sessionId,
  });

  static PresenceEntry? tryParse(Object? value) {
    if (value is! Map<String, dynamic>) return null;
    final userId = value['userId'];
    final email = value['email'];
    final scope = switch (value['scope']) {
      'workspace' => PresenceScope.workspace,
      'peon' => PresenceScope.peon,
      'session' => PresenceScope.session,
      _ => null,
    };
    if (userId is! String || email is! String || scope == null) return null;
    return PresenceEntry(
      userId: userId,
      email: email,
      scope: scope,
      githubLogin: value['githubLogin'] as String?,
      avatarUrl: value['avatarUrl'] as String?,
      peonId: value['peonId'] as String?,
      sessionId: value['sessionId'] as String?,
    );
  }

  final PresenceScope scope;
  final String? peonId;
  final String? sessionId;
}

class PresenceState {
  const PresenceState({
    this.entriesByWorkspace = const <String, List<PresenceEntry>>{},
  });

  final Map<String, List<PresenceEntry>> entriesByWorkspace;

  List<PresenceViewer> viewersForPeon({
    required String workspaceId,
    required String peonId,
  }) {
    return _uniqueViewers(
      (entriesByWorkspace[workspaceId] ?? const []).where(
        (entry) => entry.peonId == peonId,
      ),
    );
  }

  List<PresenceViewer> viewersForSession({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) {
    return _uniqueViewers(
      (entriesByWorkspace[workspaceId] ?? const []).where(
        (entry) =>
            entry.scope == PresenceScope.session &&
            entry.peonId == peonId &&
            entry.sessionId == sessionId,
      ),
    );
  }

  static List<PresenceViewer> _uniqueViewers(Iterable<PresenceEntry> entries) {
    final unique = <String, PresenceViewer>{};
    for (final entry in entries) {
      unique.putIfAbsent(entry.email.toLowerCase(), () => entry);
    }
    final viewers = unique.values.toList()
      ..sort((a, b) => a.displayName.compareTo(b.displayName));
    return List.unmodifiable(viewers);
  }
}

class PresenceController extends Notifier<PresenceState> {
  @override
  PresenceState build() => const PresenceState();

  void replaceWorkspace(String workspaceId, Iterable<PresenceEntry> entries) {
    state = PresenceState(
      entriesByWorkspace: {
        ...state.entriesByWorkspace,
        workspaceId: List.unmodifiable(entries),
      },
    );
  }

  void clearWorkspace(String workspaceId) {
    if (!state.entriesByWorkspace.containsKey(workspaceId)) return;
    final next = Map<String, List<PresenceEntry>>.from(state.entriesByWorkspace)
      ..remove(workspaceId);
    state = PresenceState(entriesByWorkspace: next);
  }
}
