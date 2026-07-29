part of 'web_socket_fleet_live_service.dart';

extension _WebSocketFleetLiveActiveSessions on WebSocketFleetLiveService {
  Future<void> _seedActiveSessions(
    String workspaceId,
    _WorkspaceSocket state,
    int generation,
  ) async {
    try {
      var offset = 0;
      var total = 0;
      final seeded = <String, _SessionState>{};
      do {
        final response = await _dio.get<Map<String, dynamic>>(
          'workspaces/${Uri.encodeComponent(workspaceId)}/sessions',
          queryParameters: {
            'status': 'running',
            'limit': 200,
            'offset': offset,
          },
        );
        final sessions = response.data?['sessions'];
        if (sessions is! List) {
          throw const FormatException('Invalid active-session response');
        }
        total = (response.data?['total'] as num?)?.toInt() ?? sessions.length;
        for (final session in sessions) {
          if (session is! Map<String, dynamic>) continue;
          final peonId = session['peonId'];
          final sessionId = session['sessionId'];
          if (peonId is! String || sessionId is! String) continue;
          seeded['$peonId\u0000$sessionId'] = _SessionState(
            peonId: peonId,
            sessionId: sessionId,
            status: 'running',
            projectId: session['projectId'] as String?,
            projectKey: session['projectKey'] as String?,
            title: session['title'] as String?,
            promptPreview: session['promptPreview'] as String?,
            preview: session['preview'] as String?,
            author: session['author'] as String?,
            startedAt: (session['startedAt'] as num?)?.toDouble(),
            lastActivityAt: (session['lastActivityAt'] as num?)?.toDouble(),
            syncedAt: (session['syncedAt'] as num?)?.toDouble() ?? 0,
          );
        }
        offset += sessions.length;
        if (sessions.isEmpty) break;
      } while (offset < total);

      if (_stopped ||
          _sockets[workspaceId] != state ||
          state.activeSeedGeneration != generation) {
        return;
      }
      state.sessions
        ..clear()
        ..addAll(seeded);
      state.activeSeedComplete = true;
      _publishActiveSessionsWhenReady(workspaceId, state);
    } catch (error) {
      _diagnostics.record(
        AppDiagnosticEvent(
          name: 'live.active_seed',
          level: AppDiagnosticLevel.warning,
          workspaceId: workspaceId,
          state: 'failed',
          errorType: error.runtimeType.toString(),
        ),
      );
    }
  }

  void _publishActiveSessionsWhenReady(
    String workspaceId,
    _WorkspaceSocket state,
  ) {
    if (state.activeSeeded ||
        !state.activeSeedComplete ||
        state.activeReplayEndsRemaining > 0) {
      return;
    }
    for (final event in state.pendingSessions) {
      _applySession(workspaceId, state, event, notify: false);
    }
    state.pendingSessions.clear();
    state.activeSeeded = true;
    for (final peonId in state.peonIds) {
      _notifyActiveCount(workspaceId, state, peonId);
    }
    _notifyActiveSessionSnapshot(workspaceId, state);
  }

  void _applySession(
    String workspaceId,
    _WorkspaceSocket state,
    Map<String, dynamic> payload, {
    bool notify = true,
  }) {
    final sessionId = payload['sessionId'];
    final peonId = payload['peonId'];
    if (sessionId is! String || peonId is! String) return;
    final syncedAt = (payload['syncedAt'] as num?)?.toDouble() ?? 0;
    final key = '$peonId\u0000$sessionId';
    final previous = state.sessions[key];
    if (previous != null && syncedAt > 0 && syncedAt < previous.syncedAt) {
      return;
    }
    final status = payload['deleted'] == true
        ? 'deleted'
        : payload['status'] as String?;
    state.sessions[key] = _SessionState(
      peonId: peonId,
      sessionId: sessionId,
      status: status,
      projectId: payload['projectId'] as String? ?? previous?.projectId,
      projectKey: payload['projectKey'] as String? ?? previous?.projectKey,
      title: payload['title'] as String? ?? previous?.title,
      promptPreview:
          payload['promptPreview'] as String? ?? previous?.promptPreview,
      preview: payload['preview'] as String? ?? previous?.preview,
      author: payload['author'] as String? ?? previous?.author,
      startedAt:
          (payload['startedAt'] as num?)?.toDouble() ?? previous?.startedAt,
      lastActivityAt:
          (payload['lastActivityAt'] as num?)?.toDouble() ??
          previous?.lastActivityAt,
      syncedAt: syncedAt,
    );
    if (notify &&
        (previous?.status == 'running' || status == 'running') &&
        previous?.status != status) {
      _notifyActiveCount(workspaceId, state, peonId);
    }
    if (notify &&
        (previous?.status == 'running' || status == 'running') &&
        (previous?.status != status ||
            previous?.projectId != state.sessions[key]?.projectId ||
            previous?.projectKey != state.sessions[key]?.projectKey ||
            previous?.title != state.sessions[key]?.title ||
            previous?.promptPreview != state.sessions[key]?.promptPreview ||
            previous?.preview != state.sessions[key]?.preview ||
            previous?.author != state.sessions[key]?.author ||
            previous?.startedAt != state.sessions[key]?.startedAt ||
            previous?.lastActivityAt != state.sessions[key]?.lastActivityAt)) {
      _notifyActiveSessionSnapshot(workspaceId, state);
    }
  }

  void _notifyActiveCount(
    String workspaceId,
    _WorkspaceSocket state,
    String peonId,
  ) {
    final count = state.sessions.values
        .where(
          (session) => session.peonId == peonId && session.status == 'running',
        )
        .length;
    _onActiveSessions?.call(workspaceId, peonId, count);
  }

  void _notifyActiveSessionSnapshot(
    String workspaceId,
    _WorkspaceSocket state,
  ) {
    _onActiveSessionSnapshot?.call(workspaceId, [
      for (final session in state.sessions.values)
        if (session.status == 'running')
          ActiveSession(
            peonId: session.peonId,
            sessionId: session.sessionId,
            projectId: session.projectId,
            projectKey: session.projectKey,
            title: session.title,
            promptPreview: session.promptPreview,
            preview: session.preview,
            author: session.author,
            startedAt: session.startedAt,
            lastActivityAt: session.lastActivityAt,
          ),
    ]);
  }
}
