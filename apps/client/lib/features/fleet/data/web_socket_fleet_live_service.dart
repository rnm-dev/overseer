import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:dio/dio.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../../../core/diagnostics/app_diagnostics.dart';
import '../../../core/live/active_sessions.dart';
import '../../../core/live/presence.dart';
import '../../../core/live/transcript_live_service.dart';
import '../../../core/network/overseer_http_client.dart';
import '../../../core/time/app_time.dart';
import '../application/fleet_live_service.dart';

part 'web_socket_fleet_live_active_sessions.dart';
part 'web_socket_fleet_live_protocol.dart';
part 'web_socket_fleet_live_state.dart';
part 'web_socket_fleet_live_transcripts.dart';

class WebSocketFleetLiveService
    implements
        FleetLiveService,
        FleetWorkspaceReconciler,
        FleetLiveLifecycle,
        AttentionFleetLiveService,
        TranscriptLiveService {
  WebSocketFleetLiveService({
    required this.serverUrl,
    required Uri apiUrl,
    required String token,
    Dio? dio,
    this._clock = const SystemAppClock(),
    this._scheduler = const SystemAppScheduler(),
    this._diagnostics = const NoopAppDiagnostics(),
  }) : _dio = dio ?? createOverseerHttpClient(apiUrl: apiUrl, token: token);

  static const _heartbeatInterval = Duration(seconds: 10);
  static const _staleInterval = Duration(seconds: 25);

  final Uri serverUrl;
  final Dio _dio;
  final AppClock _clock;
  final AppScheduler _scheduler;
  final AppDiagnostics _diagnostics;
  final Map<String, _WorkspaceSocket> _sockets = {};
  final Random _random = Random();

  bool _stopped = true;
  void Function(String workspaceId, Map<String, dynamic> peon)? _onPeon;
  Future<void> Function(
    String workspaceId,
    int cursor,
    Map<String, dynamic> session,
  )?
  _onSession;
  Future<void> Function(
    String workspaceId,
    int cursor,
    Map<String, dynamic> attention,
  )?
  _onAttention;
  Future<void> Function(
    String workspaceId,
    int cursor,
    Map<String, dynamic> project,
  )?
  _onProject;
  Future<void> Function(String workspaceId, int cursor)? _onCursor;
  void Function(String workspaceId, String peonId, int activeSessions)?
  _onActiveSessions;
  void Function(String workspaceId, List<ActiveSession>? activeSessions)?
  _onActiveSessionSnapshot;
  void Function(String workspaceId, List<PresenceEntry> presence)? _onPresence;

  @override
  Future<void> connect({
    required List<String> workspaceIds,
    required Map<String, int> initialCursors,
    required void Function(String workspaceId, Map<String, dynamic> peon)
    onPeon,
    required Future<void> Function(
      String workspaceId,
      int cursor,
      Map<String, dynamic> session,
    )
    onSession,
    required Future<void> Function(
      String workspaceId,
      int cursor,
      Map<String, dynamic> project,
    )
    onProject,
    required Future<void> Function(String workspaceId, int cursor) onCursor,
    required void Function(
      String workspaceId,
      String peonId,
      int activeSessions,
    )
    onActiveSessions,
    required void Function(
      String workspaceId,
      List<ActiveSession>? activeSessions,
    )
    onActiveSessionSnapshot,
    required void Function(String workspaceId, List<PresenceEntry> presence)
    onPresence,
  }) async {
    await stop();
    _stopped = false;
    _onPeon = onPeon;
    _onSession = onSession;
    _onProject = onProject;
    _onCursor = onCursor;
    _onActiveSessions = onActiveSessions;
    _onActiveSessionSnapshot = onActiveSessionSnapshot;
    _onPresence = onPresence;
    for (final workspaceId in workspaceIds) {
      _sockets[workspaceId] = _WorkspaceSocket(
        cursor: initialCursors[workspaceId] ?? 0,
      );
      unawaited(_open(workspaceId));
    }
  }

  @override
  void setAttentionHandler(
    Future<void> Function(
      String workspaceId,
      int cursor,
      Map<String, dynamic> attention,
    )
    handler,
  ) {
    _onAttention = handler;
  }

  Future<void> _open(String workspaceId) async {
    final state = _sockets[workspaceId];
    if (_stopped || state == null || state.connecting) return;
    state
      ..connecting = true
      ..retryTimer?.cancel()
      ..retryTimer = null;
    _diagnostics.record(
      AppDiagnosticEvent(
        name: 'live.connection',
        workspaceId: workspaceId,
        state: 'connecting',
        cursor: state.cursor,
        attempt: state.attempt,
      ),
    );

    try {
      final response = await _dio.post<Map<String, dynamic>>('auth/ws-ticket');
      final ticket = response.data?['ticket'] as String?;
      if (ticket == null || ticket.isEmpty) {
        throw const FormatException('Missing WebSocket ticket');
      }
      if (_stopped || _sockets[workspaceId] != state) return;

      final socketUrl = serverUrl.replace(
        scheme: serverUrl.scheme == 'https' ? 'wss' : 'ws',
        path: '/api/ws',
        queryParameters: {'ticket': ticket},
      );
      final channel = WebSocketChannel.connect(socketUrl);
      state.channel = channel;
      await channel.ready;
      if (_stopped || _sockets[workspaceId] != state) {
        await channel.sink.close();
        return;
      }

      state
        ..connecting = false
        ..lastReceivedAt = _clock.now();
      channel.sink.add(
        jsonEncode({
          'type': 'hello',
          'workspaceId': workspaceId,
          'cursor': state.cursor,
        }),
      );
      state.subscription = channel.stream.listen(
        (data) {
          state.messageQueue = state.messageQueue
              .then((_) => _handle(workspaceId, state, data))
              .onError((_, _) => _disconnected(workspaceId, state));
        },
        onError: (_) => _disconnected(workspaceId, state),
        onDone: () => _disconnected(workspaceId, state),
        cancelOnError: true,
      );
      state.heartbeat = _scheduler.periodic(
        _heartbeatInterval,
        () => _heartbeat(workspaceId, state),
      );
    } catch (error) {
      state.connecting = false;
      _diagnostics.record(
        AppDiagnosticEvent(
          name: 'live.connection',
          level: AppDiagnosticLevel.warning,
          workspaceId: workspaceId,
          state: 'failed',
          outcome: 'retrying',
          cursor: state.cursor,
          attempt: state.attempt,
          errorType: error.runtimeType.toString(),
        ),
      );
      _scheduleReconnect(workspaceId, state);
    }
  }

  @override
  Future<void> reconcileWorkspaces({
    required List<String> workspaceIds,
    required Map<String, int> initialCursors,
  }) async {
    if (_stopped) return;
    final desired = workspaceIds.toSet();
    final removed = _sockets.keys
        .where((workspaceId) => !desired.contains(workspaceId))
        .toList();
    for (final workspaceId in removed) {
      final state = _sockets.remove(workspaceId);
      if (state == null) continue;
      await _closeWorkspace(state);
      _onPresence?.call(workspaceId, const []);
      _onActiveSessionSnapshot?.call(workspaceId, const []);
    }
    for (final workspaceId in desired) {
      if (_sockets.containsKey(workspaceId)) continue;
      _sockets[workspaceId] = _WorkspaceSocket(
        cursor: initialCursors[workspaceId] ?? 0,
      );
      unawaited(_open(workspaceId));
    }
  }

  @override
  Future<void> resumeFromBackground() async {
    if (_stopped || _sockets.isEmpty) return;
    final staleSockets = <_WorkspaceSocket>[];
    for (final entry in _sockets.entries.toList()) {
      final stale = entry.value;
      final replacement = _WorkspaceSocket(cursor: stale.cursor)
        ..location = stale.location
        ..tails.addAll(stale.tails);
      for (final handler in replacement.tails.values) {
        handler.retryTimer?.cancel();
        handler.retryTimer = null;
      }
      _sockets[entry.key] = replacement;
      staleSockets.add(stale);
    }
    for (final stale in staleSockets) {
      unawaited(_closeWorkspace(stale));
    }
    if (_stopped) return;
    for (final workspaceId in _sockets.keys.toList()) {
      unawaited(_open(workspaceId));
    }
  }

  @override
  void setPresence({
    required String workspaceId,
    required PresenceLocation location,
  }) {
    final state = _sockets[workspaceId];
    if (_stopped || state == null) return;
    state.location = location;
    if (state.ready) _sendPresence(state);
  }

  void _sendPresence(_WorkspaceSocket state) {
    state.channel?.sink.add(jsonEncode(state.location.toJson()));
  }

  @override
  void subscribeTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String? lastEventId,
    required Future<void> Function(TranscriptTailFrame frame) onFrame,
  }) {
    final state = _sockets[workspaceId];
    if (_stopped || state == null) return;
    final previous = state.tails[sessionId];
    previous?.retryTimer?.cancel();
    if (state.ready && previous != null && previous.peonId != peonId) {
      state.channel?.sink.add(
        jsonEncode({'type': 'unsubscribe', 'sessionId': sessionId}),
      );
    }
    final handler = _TailHandler(
      peonId: peonId,
      sessionId: sessionId,
      lastEventId: lastEventId,
      onFrame: onFrame,
    );
    state.tails[sessionId] = handler;
    if (state.ready) _sendTailSubscription(state, handler);
  }

  @override
  void unsubscribeTranscript({
    required String workspaceId,
    required String sessionId,
  }) {
    final state = _sockets[workspaceId];
    final handler = state?.tails.remove(sessionId);
    handler?.retryTimer?.cancel();
    if (state?.ready == true) {
      state?.channel?.sink.add(
        jsonEncode({'type': 'unsubscribe', 'sessionId': sessionId}),
      );
    }
  }

  void _heartbeat(String workspaceId, _WorkspaceSocket state) {
    if (_stopped || _sockets[workspaceId] != state) return;
    if (_clock.now().difference(state.lastReceivedAt) > _staleInterval) {
      _diagnostics.record(
        AppDiagnosticEvent(
          name: 'live.connection',
          level: AppDiagnosticLevel.warning,
          workspaceId: workspaceId,
          state: 'stale',
          outcome: 'reconnecting',
          cursor: state.cursor,
        ),
      );
      unawaited(state.channel?.sink.close());
      _disconnected(workspaceId, state);
      return;
    }
    state.channel?.sink.add(jsonEncode({'type': 'ping'}));
  }

  void _disconnected(String workspaceId, _WorkspaceSocket state) {
    if (_sockets[workspaceId] != state || state.reconnecting) return;
    final subscription = state.subscription;
    final channel = state.channel;
    state
      ..reconnecting = true
      ..ready = false
      ..connecting = false;
    state.heartbeat?.cancel();
    state.heartbeat = null;
    state.subscription = null;
    state.channel = null;
    unawaited(() async {
      await subscription?.cancel();
      await channel?.sink.close();
    }());
    _diagnostics.record(
      AppDiagnosticEvent(
        name: 'live.connection',
        level: AppDiagnosticLevel.warning,
        workspaceId: workspaceId,
        state: 'disconnected',
        outcome: 'retrying',
        cursor: state.cursor,
        attempt: state.attempt,
      ),
    );
    _scheduleReconnect(workspaceId, state);
  }

  void _scheduleReconnect(String workspaceId, _WorkspaceSocket state) {
    if (_stopped || _sockets[workspaceId] != state) return;
    state
      ..reconnecting = false
      ..attempt += 1;
    final baseMs = min(1000 * (1 << min(state.attempt - 1, 3)), 10000);
    final delay = Duration(
      milliseconds: (baseMs * (0.8 + _random.nextDouble() * 0.4)).round(),
    );
    state.retryTimer?.cancel();
    _diagnostics.record(
      AppDiagnosticEvent(
        name: 'live.retry',
        workspaceId: workspaceId,
        state: 'scheduled',
        cursor: state.cursor,
        attempt: state.attempt,
      ),
    );
    state.retryTimer = _scheduler.schedule(
      delay,
      () => unawaited(_open(workspaceId)),
    );
  }

  @override
  Future<void> stop() async {
    _stopped = true;
    final sockets = _sockets.values.toList();
    _sockets.clear();
    _onPeon = null;
    _onSession = null;
    _onProject = null;
    _onCursor = null;
    _onActiveSessions = null;
    _onActiveSessionSnapshot = null;
    _onPresence = null;
    for (final state in sockets) {
      await _closeWorkspace(state);
    }
  }

  Future<void> _closeWorkspace(_WorkspaceSocket state) async {
    state.retryTimer?.cancel();
    state.heartbeat?.cancel();
    for (final handler in state.tails.values) {
      handler.retryTimer?.cancel();
    }
    await state.subscription?.cancel();
    await state.channel?.sink.close();
  }
}
