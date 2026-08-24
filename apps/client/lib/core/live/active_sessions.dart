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
    this.localByWorkspace = const <String, ActiveWorkspaceSessions>{},
  });

  final Map<String, ActiveWorkspaceSessions> authoritativeByWorkspace;
  final Map<String, ActiveWorkspaceSessions> restByWorkspace;
  final Map<String, ActiveWorkspaceSessions> localByWorkspace;

  ActiveWorkspaceSessions? forWorkspace(String workspaceId) {
    final base =
        authoritativeByWorkspace[workspaceId] ?? restByWorkspace[workspaceId];
    final local = localByWorkspace[workspaceId];
    if (local == null || local.sessions.isEmpty) return base;
    return ActiveWorkspaceSessions([
      ...?base?.sessions.where(
        (session) => !local.contains(
          peonId: session.peonId,
          sessionId: session.sessionId,
        ),
      ),
      ...local.sessions,
    ]);
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
      localByWorkspace: state.localByWorkspace,
    );
  }

  void replaceWorkspace(String workspaceId, Iterable<ActiveSession> sessions) {
    final replacement = ActiveWorkspaceSessions(sessions);
    final previous = state.authoritativeByWorkspace[workspaceId];
    final local = state.localByWorkspace[workspaceId];
    final retainedLocal = local?.sessions.where((session) {
      final wasAuthoritative =
          previous?.contains(
            peonId: session.peonId,
            sessionId: session.sessionId,
          ) ??
          false;
      final isAuthoritative = replacement.contains(
        peonId: session.peonId,
        sessionId: session.sessionId,
      );
      return !wasAuthoritative && !isAuthoritative;
    }).toList();
    final nextLocal = Map<String, ActiveWorkspaceSessions>.from(
      state.localByWorkspace,
    );
    if (retainedLocal == null || retainedLocal.isEmpty) {
      nextLocal.remove(workspaceId);
    } else {
      nextLocal[workspaceId] = ActiveWorkspaceSessions(retainedLocal);
    }
    state = ActiveSessionsState(
      authoritativeByWorkspace: {
        ...state.authoritativeByWorkspace,
        workspaceId: replacement,
      },
      restByWorkspace: state.restByWorkspace,
      localByWorkspace: nextLocal,
    );
  }

  void markRunningLocally({
    required String workspaceId,
    required ActiveSession session,
  }) {
    final previous = state.localByWorkspace[workspaceId]?.sessions ?? const [];
    state = ActiveSessionsState(
      authoritativeByWorkspace: state.authoritativeByWorkspace,
      restByWorkspace: state.restByWorkspace,
      localByWorkspace: {
        ...state.localByWorkspace,
        workspaceId: ActiveWorkspaceSessions([
          for (final candidate in previous)
            if (candidate.peonId != session.peonId ||
                candidate.sessionId != session.sessionId)
              candidate,
          session,
        ]),
      },
    );
  }

  void clearRunningLocally({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) {
    final previous = state.localByWorkspace[workspaceId]?.sessions;
    if (previous == null) return;
    final nextSessions = previous
        .where(
          (session) =>
              session.peonId != peonId || session.sessionId != sessionId,
        )
        .toList();
    if (nextSessions.length == previous.length) return;
    final next = Map<String, ActiveWorkspaceSessions>.from(
      state.localByWorkspace,
    );
    if (nextSessions.isEmpty) {
      next.remove(workspaceId);
    } else {
      next[workspaceId] = ActiveWorkspaceSessions(nextSessions);
    }
    state = ActiveSessionsState(
      authoritativeByWorkspace: state.authoritativeByWorkspace,
      restByWorkspace: state.restByWorkspace,
      localByWorkspace: next,
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
      localByWorkspace: state.localByWorkspace,
    );
  }
}
