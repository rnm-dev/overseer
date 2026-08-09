part of 'web_socket_fleet_live_service.dart';

extension _WebSocketFleetLiveProtocol on WebSocketFleetLiveService {
  Future<void> _handle(
    String workspaceId,
    _WorkspaceSocket state,
    Object? raw,
  ) async {
    if (raw is! String || _sockets[workspaceId] != state) return;
    state.lastReceivedAt = _clock.now();
    final Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } on FormatException {
      return;
    }
    if (decoded is! Map<String, dynamic>) return;

    final type = decoded['type'];
    if (type == 'snapshot') {
      final snapshotCursor = (decoded['cursor'] as num?)?.toInt() ?? 0;
      final resumeCursor = state.cursor;
      final seedGeneration = ++state.activeSeedGeneration;
      state
        ..ready = true
        ..attempt = 0
        ..activeSeeded = false
        ..activeSeedComplete = false
        ..activeReplayEndsRemaining = snapshotCursor > resumeCursor ? 2 : 1;
      _onActiveSessionSnapshot?.call(workspaceId, null);
      state.pendingSessions.clear();
      for (final peon in (decoded['peonPresence'] as List? ?? const [])) {
        if (peon is Map<String, dynamic>) {
          final peonId = peon['peonId'];
          if (peonId is String) state.peonIds.add(peonId);
          _onPeon?.call(workspaceId, peon);
        }
      }
      _replacePresence(workspaceId, decoded['presence']);
      _diagnostics.record(
        AppDiagnosticEvent(
          name: 'live.connection',
          workspaceId: workspaceId,
          state: 'connected',
          cursor: state.cursor,
        ),
      );
      if (snapshotCursor > resumeCursor) {
        state.channel?.sink.add(
          jsonEncode({'type': 'resume', 'cursor': resumeCursor}),
        );
      }
      for (final handler in state.tails.values) {
        _sendTailSubscription(state, handler);
      }
      _sendPresence(state);
      unawaited(_seedActiveSessions(workspaceId, state, seedGeneration));
      return;
    }
    if (type == 'presence') {
      _replacePresence(workspaceId, decoded['presence']);
      return;
    }
    if (type == 'presenceRetry') {
      _scheduler.schedule(const Duration(seconds: 1), () {
        if (!_stopped && _sockets[workspaceId] == state && state.ready) {
          _sendPresence(state);
        }
      });
      return;
    }
    if (type == 'peon') {
      final cursor = (decoded['cursor'] as num?)?.toInt() ?? 0;
      if (cursor > 0) await _onCursor?.call(workspaceId, cursor);
      _bumpCursor(workspaceId, state, cursor);
      final payload = decoded['payload'];
      if (payload is Map<String, dynamic>) {
        _onPeon?.call(workspaceId, payload);
      }
      return;
    }
    if (type == 'session') {
      final cursor = (decoded['cursor'] as num?)?.toInt() ?? 0;
      final payload = decoded['payload'];
      if (payload is Map<String, dynamic>) {
        await _onSession?.call(workspaceId, cursor, payload);
        _bumpCursor(workspaceId, state, cursor);
        if (state.activeSeeded) {
          _applySession(workspaceId, state, payload);
        } else {
          state.pendingSessions.add(payload);
        }
        if (cursor > 0) {
          state.channel?.sink.add(
            jsonEncode({'type': 'session:applied', 'cursor': cursor}),
          );
        }
      }
      return;
    }
    if (type == 'attention') {
      final cursor = (decoded['cursor'] as num?)?.toInt() ?? 0;
      final payload = decoded['payload'];
      if (payload is Map<String, dynamic>) {
        await _onAttention?.call(workspaceId, cursor, payload);
        _bumpCursor(workspaceId, state, cursor);
      }
      return;
    }
    if (type == 'project') {
      final cursor = (decoded['cursor'] as num?)?.toInt() ?? 0;
      final payload = decoded['payload'];
      if (payload is Map<String, dynamic>) {
        await _onProject?.call(workspaceId, cursor, payload);
        _bumpCursor(workspaceId, state, cursor);
      }
      return;
    }
    if (type == 'resumeEnd') {
      final cursor = (decoded['cursor'] as num?)?.toInt() ?? 0;
      if (cursor > 0) await _onCursor?.call(workspaceId, cursor);
      _bumpCursor(workspaceId, state, cursor);
      if (!state.activeSeeded && state.activeReplayEndsRemaining > 0) {
        state.activeReplayEndsRemaining -= 1;
        _publishActiveSessionsWhenReady(workspaceId, state);
      }
      return;
    }
    if (type == 'sync') {
      final serverCursor = (decoded['cursor'] as num?)?.toInt() ?? 0;
      if (serverCursor > state.cursor) {
        if (!state.activeSeeded) state.activeReplayEndsRemaining += 1;
        state.channel?.sink.add(
          jsonEncode({'type': 'resume', 'cursor': state.cursor}),
        );
      }
      return;
    }
    if (type == 'tail') {
      final sessionId = decoded['sessionId'];
      if (sessionId is! String) return;
      final handler = state.tails[sessionId];
      if (handler == null ||
          (decoded['peonId'] != null && decoded['peonId'] != handler.peonId)) {
        return;
      }
      handler
        ..retryTimer?.cancel()
        ..retryTimer = null
        ..attempt = 0;
      final eventId = decoded['id'] as String?;
      await handler.onFrame(
        TranscriptTailFrame.event(
          eventId: eventId,
          event: decoded['event'] as String?,
          data: decoded['data'] as String? ?? '',
        ),
      );
      // The handler commits transcript events to Drift. Advancing before that
      // future completes can acknowledge an event that never became durable;
      // a reconnect would then resume after it and create a permanent gap.
      if (eventId?.isNotEmpty == true) handler.lastEventId = eventId;
      return;
    }
    if (type == 'tailEnd' || type == 'tailError') {
      final sessionId = decoded['sessionId'];
      if (sessionId is! String) return;
      final handler = state.tails[sessionId];
      if (handler == null ||
          (decoded['peonId'] != null && decoded['peonId'] != handler.peonId) ||
          handler.retryTimer != null) {
        return;
      }
      final retryable = decoded['retryable'] != false;
      _diagnostics.record(
        AppDiagnosticEvent(
          name: 'transcript.tail',
          level: retryable
              ? AppDiagnosticLevel.warning
              : AppDiagnosticLevel.error,
          workspaceId: workspaceId,
          sessionId: sessionId,
          state: 'terminal',
          outcome: retryable ? 'retrying' : 'stopped',
          attempt: handler.attempt,
        ),
      );
      await handler.onFrame(
        TranscriptTailFrame.terminal(
          retryable: retryable,
          error: decoded['error'] as String?,
        ),
      );
      if (retryable) _scheduleTailRetry(state, handler);
    }
  }

  void _replacePresence(String workspaceId, Object? rawPresence) {
    final entries = <PresenceEntry>[];
    for (final value in rawPresence is List ? rawPresence : const []) {
      final entry = PresenceEntry.tryParse(value);
      if (entry != null) entries.add(entry);
    }
    _onPresence?.call(workspaceId, entries);
  }

  int _bumpCursor(String workspaceId, _WorkspaceSocket state, Object? value) {
    final cursor = (value as num?)?.toInt() ?? 0;
    if (cursor > state.cursor) {
      state.cursor = cursor;
      _diagnostics.record(
        AppDiagnosticEvent(
          name: 'live.cursor',
          workspaceId: workspaceId,
          state: 'advanced',
          cursor: cursor,
        ),
      );
    }
    return cursor;
  }
}
