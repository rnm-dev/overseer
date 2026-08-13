import 'package:flutter_riverpod/flutter_riverpod.dart';

final activeSessionsProvider =
    NotifierProvider<ActiveSessionsController, ActiveSessionsState>(
      ActiveSessionsController.new,
    );

class ActiveSession {
  const ActiveSession({
    required this.peonId,
    required this.sessionId,
    this.projectId,
    this.projectKey,
    this.title,
    this.promptPreview,
    this.preview,
    this.author,
    this.startedAt,
    this.lastActivityAt,
  });

  final String peonId;
  final String sessionId;
  final String? projectId;
  final String? projectKey;
  final String? title;
  final String? promptPreview;
  final String? preview;
  final String? author;
  final double? startedAt;
  final double? lastActivityAt;
}

class ActiveWorkspaceSessions {
  ActiveWorkspaceSessions(Iterable<ActiveSession> sessions)
    : sessions = List.unmodifiable(sessions);

  final List<ActiveSession> sessions;

  bool contains({required String peonId, required String sessionId}) {
    return sessions.any(
      (session) => session.peonId == peonId && session.sessionId == sessionId,
    );
  }

  int countForProject({
    required String peonId,
    required String projectId,
    required String projectKey,
  }) {
    return sessions
        .where(
          (session) =>
              session.peonId == peonId &&
              (session.projectId == projectId ||
                  session.projectKey == projectKey),
        )
        .length;
  }
}

class ActiveSessionsState {
  const ActiveSessionsState({
    this.authoritativeByWorkspace = const <String, ActiveWorkspaceSessions>{},
    this.restByWorkspace = const <String, ActiveWorkspaceSessions>{},
  });

  final Map<String, ActiveWorkspaceSessions> authoritativeByWorkspace;
  final Map<String, ActiveWorkspaceSessions> restByWorkspace;

  ActiveWorkspaceSessions? forWorkspace(String workspaceId) {
    return authoritativeByWorkspace[workspaceId] ??
        restByWorkspace[workspaceId];
  }
}

class ActiveSessionsController extends Notifier<ActiveSessionsState> {
  @override
  ActiveSessionsState build() => const ActiveSessionsState();

  void markUnknown(String workspaceId) {
    if (!state.authoritativeByWorkspace.containsKey(workspaceId)) return;
    final next = Map<String, ActiveWorkspaceSessions>.from(
      state.authoritativeByWorkspace,
    )..remove(workspaceId);
    state = ActiveSessionsState(
      authoritativeByWorkspace: next,
      restByWorkspace: state.restByWorkspace,
    );
  }

  void replaceWorkspace(String workspaceId, Iterable<ActiveSession> sessions) {
    state = ActiveSessionsState(
      authoritativeByWorkspace: {
        ...state.authoritativeByWorkspace,
        workspaceId: ActiveWorkspaceSessions(sessions),
      },
      restByWorkspace: state.restByWorkspace,
    );
  }

  void reconcileRestPage({
    required String workspaceId,
    required String peonId,
    required Iterable<String> returnedSessionIds,
    required Iterable<ActiveSession> runningSessions,
  }) {
    final returned = returnedSessionIds.toSet();
    final previous = state.restByWorkspace[workspaceId]?.sessions ?? const [];
    final next = [
      for (final session in previous)
        if (session.peonId != peonId || !returned.contains(session.sessionId))
          session,
      ...runningSessions,
    ];
    state = ActiveSessionsState(
      authoritativeByWorkspace: state.authoritativeByWorkspace,
      restByWorkspace: {
        ...state.restByWorkspace,
        workspaceId: ActiveWorkspaceSessions(next),
      },
    );
  }
}
