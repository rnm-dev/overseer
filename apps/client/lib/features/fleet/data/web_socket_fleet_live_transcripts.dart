part of 'web_socket_fleet_live_service.dart';

extension _WebSocketFleetLiveTranscripts on WebSocketFleetLiveService {
  void _sendTailSubscription(_WorkspaceSocket state, _TailHandler handler) {
    state.channel?.sink.add(
      jsonEncode({
        'type': 'subscribe',
        'peonId': handler.peonId,
        'sessionId': handler.sessionId,
        if (handler.lastEventId?.isNotEmpty == true)
          'lastEventId': handler.lastEventId,
      }),
    );
  }

  void _scheduleTailRetry(_WorkspaceSocket state, _TailHandler handler) {
    if (_stopped ||
        state.tails[handler.sessionId] != handler ||
        handler.retryTimer != null) {
      return;
    }
    final delayMs = min(1000 * (1 << min(handler.attempt, 3)), 10000);
    handler.attempt += 1;
    _diagnostics.record(
      AppDiagnosticEvent(
        name: 'transcript.tail_retry',
        workspaceId: _workspaceIdFor(state),
        sessionId: handler.sessionId,
        state: 'scheduled',
        attempt: handler.attempt,
      ),
    );
    handler.retryTimer = _scheduler.schedule(
      Duration(milliseconds: delayMs),
      () {
        handler.retryTimer = null;
        if (!_stopped &&
            state.ready &&
            state.tails[handler.sessionId] == handler) {
          _sendTailSubscription(state, handler);
        }
      },
    );
  }

  String? _workspaceIdFor(_WorkspaceSocket state) {
    for (final entry in _sockets.entries) {
      if (identical(entry.value, state)) return entry.key;
    }
    return null;
  }
}
