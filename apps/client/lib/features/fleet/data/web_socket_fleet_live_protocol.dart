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
        ..activeBarrierCursor = snapshotCursor;
      _onActiveSessionSnapshot?.call(workspaceId, null);
      state.pendingSessions.clear();
      final rawPeons = decoded['peonPresence'];
      if (rawPeons is List && rawPeons.length > 10000) {
        throw const FormatException('Peon snapshot exceeds its item limit');
      }
      final peonSnapshot = ResourceSnapshot<Map<String, dynamic>>.validated(
        authority: ResourceAuthority.peon,
        items: (rawPeons as List? ?? const []).whereType<Map>().map(
          Map<String, dynamic>.from,
        ),
        identity: (peon) => peon['peonId'] as String? ?? '',
      );
      state.peonIds.clear();
      for (final peon in peonSnapshot.items) {
        state.peonIds.add(peon['peonId'] as String);
        await _onPeon?.call(workspaceId, 0, peon);
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
      final payload = decoded['payload'];
      if (payload is Map<String, dynamic>) {
        final applied = await _onPeon?.call(workspaceId, cursor, payload);
        if (applied == true) {
          _bumpCursor(workspaceId, state, cursor);
          if (cursor > 0) {
            state.channel?.sink.add(
              jsonEncode({
                'type': 'resource:applied',
                'kind': 'peon',
                'cursor': cursor,
              }),
            );
          }
        }
      }
      return;
    }
    if (type == 'session') {
      final cursor = (decoded['cursor'] as num?)?.toInt() ?? 0;
      final payload = decoded['payload'];
      if (payload is Map<String, dynamic>) {
        final applied = await _onSession?.call(workspaceId, cursor, payload);
        if (applied == true) {
          _bumpCursor(workspaceId, state, cursor);
        }
        // The REST seed is a current snapshot taken after the socket barrier.
        // Replayed events at or before that barrier are already represented by
        // it. Only later changes participate in active-session derivation.
        if (cursor > state.activeBarrierCursor) {
          if (state.activeSeeded) {
            _applySession(workspaceId, state, payload);
          } else {
            state.pendingSessions.add(payload);
          }
        }
        if (applied == true && cursor > 0) {
          state.channel?.sink.add(
            jsonEncode({
              'type': 'resource:applied',
              'kind': 'session',
              'cursor': cursor,
            }),
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
        final applied = await _onProject?.call(workspaceId, cursor, payload);
        if (applied == true) {
          _bumpCursor(workspaceId, state, cursor);
          if (cursor > 0) {
            state.channel?.sink.add(
              jsonEncode({
                'type': 'resource:applied',
                'kind': 'project',
                'cursor': cursor,
              }),
            );
          }
        }
      }
      return;
    }
    if (type == 'resumeEnd') {
      final cursor = (decoded['cursor'] as num?)?.toInt() ?? 0;
      if (cursor > 0) await _onCursor?.call(workspaceId, cursor);
      _bumpCursor(workspaceId, state, cursor);
      return;
    }
    if (type == 'sync') {
      final serverCursor = (decoded['cursor'] as num?)?.toInt() ?? 0;
      if (serverCursor > state.cursor) {
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
