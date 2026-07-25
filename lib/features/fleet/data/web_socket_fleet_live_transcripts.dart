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
    handler.retryTimer = Timer(Duration(milliseconds: delayMs), () {
      handler.retryTimer = null;
      if (!_stopped &&
          state.ready &&
          state.tails[handler.sessionId] == handler) {
        _sendTailSubscription(state, handler);
      }
    });
  }
}
