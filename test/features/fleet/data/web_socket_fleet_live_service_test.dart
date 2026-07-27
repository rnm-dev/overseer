import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/diagnostics/app_diagnostics.dart';
import 'package:overseer_mobile/core/live/active_sessions.dart';
import 'package:overseer_mobile/features/fleet/data/web_socket_fleet_live_service.dart';

import '../../../support/manual_app_time.dart';

void main() {
  test('reconnect backoff advances without wall-clock sleeping', () async {
    final scheduler = ManualAppScheduler();
    final diagnostics = _RecordingDiagnostics();
    final adapter = _FailingTicketAdapter();
    final dio = Dio(BaseOptions(baseUrl: 'https://overseer.example/api/v1/'))
      ..httpClientAdapter = adapter;
    final service = WebSocketFleetLiveService(
      serverUrl: Uri.parse('https://overseer.example'),
      apiUrl: Uri.parse('https://overseer.example/api/v1/'),
      token: 'test-token',
      dio: dio,
      scheduler: scheduler,
      diagnostics: diagnostics,
    );
    addTearDown(service.stop);

    await service.connect(
      workspaceIds: const ['workspace-1'],
      initialCursors: const {'workspace-1': 0},
      onPeon: (_, _) {},
      onSession: (_, _, _) async {},
      onProject: (_, _, _) async {},
      onCursor: (_, _) async {},
      onActiveSessions: (_, _, _) {},
      onActiveSessionSnapshot: (_, _) {},
      onPresence: (_, _) {},
    );
    await scheduler.advance(Duration.zero);
    expect(adapter.ticketRequests, 1);

    await scheduler.advance(const Duration(seconds: 2));
    expect(adapter.ticketRequests, 2);
    expect(
      diagnostics.events.map((event) => (event.name, event.state)),
      containsAll([('live.connection', 'failed'), ('live.retry', 'scheduled')]),
    );
  });

  test(
    'foreground resume reconnects and replays a mounted transcript tail',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final probes = StreamController<_SocketProbe>.broadcast();
      final serverSubscription = server.listen((request) async {
        probes.add(_SocketProbe(await WebSocketTransformer.upgrade(request)));
      });
      final adapter = _ImmediateFleetAdapter();
      final dio = Dio(
        BaseOptions(baseUrl: 'http://127.0.0.1:${server.port}/api/v1/'),
      )..httpClientAdapter = adapter;
      final service = WebSocketFleetLiveService(
        serverUrl: Uri.parse('http://127.0.0.1:${server.port}'),
        apiUrl: Uri.parse('http://127.0.0.1:${server.port}/api/v1/'),
        token: 'test-token',
        dio: dio,
      );
      addTearDown(() async {
        await service.stop();
        await probes.close();
        await serverSubscription.cancel();
        await server.close(force: true);
      });

      await service.connect(
        workspaceIds: const ['workspace-1'],
        initialCursors: const {'workspace-1': 0},
        onPeon: (_, _) {},
        onSession: (_, _, _) async {},
        onProject: (_, _, _) async {},
        onCursor: (_, _) async {},
        onActiveSessions: (_, _, _) {},
        onActiveSessionSnapshot: (_, _) {},
        onPresence: (_, _) {},
      );

      final first = await probes.stream.first;
      await first.next('hello');
      first.socket.add(
        jsonEncode({'type': 'snapshot', 'cursor': 0, 'presence': const []}),
      );
      final tailReceived = Completer<void>();
      service.subscribeTranscript(
        workspaceId: 'workspace-1',
        peonId: 'peon-1',
        sessionId: 'session-1',
        lastEventId: null,
        onFrame: (_) async {
          if (!tailReceived.isCompleted) tailReceived.complete();
        },
      );
      await first.next('subscribe');
      first.socket.add(
        jsonEncode({
          'type': 'tail',
          'peonId': 'peon-1',
          'sessionId': 'session-1',
          'id': 'event-7',
          'data': '{"type":"assistant"}',
        }),
      );
      await tailReceived.future.timeout(const Duration(seconds: 1));

      final nextProbe = probes.stream.first;
      await service.resumeFromBackground();
      final second = await nextProbe;
      await second.next('hello');
      second.socket.add(
        jsonEncode({'type': 'snapshot', 'cursor': 0, 'presence': const []}),
      );
      final subscription = await second.next('subscribe');

      expect(subscription['lastEventId'], 'event-7');
    },
  );

  test(
    'reconnect resumes after the last durably handled transcript event',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final probes = StreamController<_SocketProbe>.broadcast();
      final serverSubscription = server.listen((request) async {
        probes.add(_SocketProbe(await WebSocketTransformer.upgrade(request)));
      });
      final adapter = _ImmediateFleetAdapter();
      final dio = Dio(
        BaseOptions(baseUrl: 'http://127.0.0.1:${server.port}/api/v1/'),
      )..httpClientAdapter = adapter;
      final service = WebSocketFleetLiveService(
        serverUrl: Uri.parse('http://127.0.0.1:${server.port}'),
        apiUrl: Uri.parse('http://127.0.0.1:${server.port}/api/v1/'),
        token: 'test-token',
        dio: dio,
      );
      addTearDown(() async {
        await service.stop();
        await probes.close();
        await serverSubscription.cancel();
        await server.close(force: true);
      });

      await service.connect(
        workspaceIds: const ['workspace-1'],
        initialCursors: const {'workspace-1': 0},
        onPeon: (_, _) {},
        onSession: (_, _, _) async {},
        onProject: (_, _, _) async {},
        onCursor: (_, _) async {},
        onActiveSessions: (_, _, _) {},
        onActiveSessionSnapshot: (_, _) {},
        onPresence: (_, _) {},
      );

      final first = await probes.stream.first;
      await first.next('hello');
      first.socket.add(
        jsonEncode({'type': 'snapshot', 'cursor': 0, 'presence': const []}),
      );
      final handlingFailed = Completer<void>();
      service.subscribeTranscript(
        workspaceId: 'workspace-1',
        peonId: 'peon-1',
        sessionId: 'session-1',
        lastEventId: 'event-7',
        onFrame: (_) async {
          if (!handlingFailed.isCompleted) handlingFailed.complete();
          throw StateError('simulated cache write failure');
        },
      );
      await first.next('subscribe');

      final reconnected = probes.stream.first;
      first.socket.add(
        jsonEncode({
          'type': 'tail',
          'peonId': 'peon-1',
          'sessionId': 'session-1',
          'id': 'event-8',
          'data': '{"type":"assistant"}',
        }),
      );
      await handlingFailed.future;

      final second = await reconnected.timeout(const Duration(seconds: 3));
      await first.closed.future.timeout(const Duration(seconds: 1));
      await second.next('hello');
      second.socket.add(
        jsonEncode({'type': 'snapshot', 'cursor': 0, 'presence': const []}),
      );
      final subscription = await second.next('subscribe');

      expect(subscription['lastEventId'], 'event-7');
    },
  );

  test(
    'publishes active counts only after the seed and both startup replays',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final socketReady = Completer<WebSocket>();
      final serverSubscription = server.listen((request) async {
        socketReady.complete(await WebSocketTransformer.upgrade(request));
      });
      final adapter = _ControlledFleetAdapter();
      final dio = Dio(
        BaseOptions(baseUrl: 'http://127.0.0.1:${server.port}/api/v1/'),
      )..httpClientAdapter = adapter;
      final service = WebSocketFleetLiveService(
        serverUrl: Uri.parse('http://127.0.0.1:${server.port}'),
        apiUrl: Uri.parse('http://127.0.0.1:${server.port}/api/v1/'),
        token: 'test-token',
        dio: dio,
      );
      addTearDown(() async {
        await service.stop();
        await serverSubscription.cancel();
        await server.close(force: true);
      });

      final counts = <int>[];
      final snapshots = <List<ActiveSession>?>[];
      final attentionEvents =
          <({String workspaceId, int cursor, Map<String, dynamic> payload})>[];
      final firstCount = Completer<void>();
      service.setAttentionHandler((workspaceId, cursor, payload) async {
        attentionEvents.add((
          workspaceId: workspaceId,
          cursor: cursor,
          payload: payload,
        ));
      });
      await service.connect(
        workspaceIds: const ['workspace-1'],
        initialCursors: const {'workspace-1': 0},
        onPeon: (_, _) {},
        onSession: (_, _, _) async {},
        onProject: (_, _, _) async {},
        onCursor: (_, _) async {},
        onActiveSessions: (_, peonId, count) {
          if (peonId != 'peon-1') return;
          counts.add(count);
          if (!firstCount.isCompleted) firstCount.complete();
        },
        onActiveSessionSnapshot: (_, sessions) => snapshots.add(sessions),
        onPresence: (_, _) {},
      );

      final socket = await socketReady.future;
      final helloReceived = Completer<void>();
      final resumeReceived = Completer<void>();
      socket.listen((raw) {
        final message = jsonDecode(raw as String) as Map<String, dynamic>;
        if (message['type'] == 'hello' && !helloReceived.isCompleted) {
          helloReceived.complete();
        }
        if (message['type'] == 'resume' && !resumeReceived.isCompleted) {
          resumeReceived.complete();
        }
      });
      await helloReceived.future;

      socket.add(
        jsonEncode({
          'type': 'snapshot',
          'cursor': 10,
          'presence': const [],
          'peonPresence': [
            {'peonId': 'peon-1', 'online': true},
          ],
        }),
      );
      await resumeReceived.future;
      await adapter.sessionsRequested.future;

      // The server finishes its snapshot-window replay first. The historical
      // replay requested from cursor zero is still queued behind it.
      socket.add(jsonEncode({'type': 'resumeEnd', 'cursor': 10}));
      adapter.completeSessions([
        _runningSession('current-1', syncedAt: 30),
        _runningSession('current-2', syncedAt: 31),
        _runningSession('current-3', syncedAt: 32),
      ]);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(counts, isEmpty);

      // These are historical transitions for a session that is completed now.
      // They must reconcile silently instead of flashing 4 then 3 in the UI.
      socket
        ..add(
          jsonEncode({
            'type': 'session',
            'cursor': 5,
            'payload': _runningSession('historical', syncedAt: 5),
          }),
        )
        ..add(
          jsonEncode({
            'type': 'session',
            'cursor': 6,
            'payload': {
              ..._runningSession('historical', syncedAt: 6),
              'status': 'completed',
            },
          }),
        );
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(counts, isEmpty);

      socket.add(jsonEncode({'type': 'resumeEnd', 'cursor': 10}));
      await firstCount.future.timeout(const Duration(seconds: 1));
      expect(counts, [3]);
      expect(snapshots.whereType<List<ActiveSession>>().single, hasLength(3));

      socket.add(
        jsonEncode({
          'type': 'session',
          'cursor': 11,
          'payload': _runningSession('live-4', syncedAt: 40),
        }),
      );
      await _waitFor(() => counts.length == 2);
      expect(counts, [3, 4]);

      socket.add(
        jsonEncode({
          'type': 'attention',
          'cursor': 12,
          'payload': {
            'peonId': 'peon-1',
            'sessionId': 'live-4',
            'hasOutstandingRequest': false,
            'attentionUnread': true,
            'updatedAt': 50,
          },
        }),
      );
      await _waitFor(() => attentionEvents.isNotEmpty);
      expect(attentionEvents.single.workspaceId, 'workspace-1');
      expect(attentionEvents.single.cursor, 12);
      expect(attentionEvents.single.payload['sessionId'], 'live-4');
    },
  );
}

Map<String, dynamic> _runningSession(
  String sessionId, {
  required double syncedAt,
}) {
  return {
    'peonId': 'peon-1',
    'sessionId': sessionId,
    'status': 'running',
    'syncedAt': syncedAt,
  };
}

Future<void> _waitFor(bool Function() condition) async {
  final deadline = DateTime.now().add(const Duration(seconds: 1));
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      fail('Timed out waiting for the expected live-sync state.');
    }
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}

class _ControlledFleetAdapter implements HttpClientAdapter {
  final sessionsRequested = Completer<void>();
  final _sessionsResponse = Completer<ResponseBody>();

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) {
    if (options.path.endsWith('auth/ws-ticket')) {
      return Future.value(_jsonResponse({'ticket': 'test-ticket'}));
    }
    if (options.path.endsWith('workspaces/workspace-1/sessions')) {
      if (!sessionsRequested.isCompleted) sessionsRequested.complete();
      return _sessionsResponse.future;
    }
    throw StateError('Unexpected request: ${options.method} ${options.path}');
  }

  void completeSessions(List<Map<String, dynamic>> sessions) {
    _sessionsResponse.complete(
      _jsonResponse({'sessions': sessions, 'total': sessions.length}),
    );
  }

  ResponseBody _jsonResponse(Map<String, dynamic> body) {
    return ResponseBody.fromString(
      jsonEncode(body),
      HttpStatus.ok,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

class _ImmediateFleetAdapter implements HttpClientAdapter {
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    if (options.path.endsWith('auth/ws-ticket')) {
      return _response({'ticket': 'test-ticket'});
    }
    if (options.path.endsWith('workspaces/workspace-1/sessions')) {
      return _response({'sessions': const [], 'total': 0});
    }
    throw StateError('Unexpected request: ${options.method} ${options.path}');
  }

  ResponseBody _response(Map<String, dynamic> body) {
    return ResponseBody.fromString(
      jsonEncode(body),
      HttpStatus.ok,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

class _FailingTicketAdapter implements HttpClientAdapter {
  int ticketRequests = 0;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    ticketRequests++;
    return ResponseBody.fromString(
      '{"error":"offline"}',
      HttpStatus.serviceUnavailable,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

class _RecordingDiagnostics implements AppDiagnostics {
  final events = <AppDiagnosticEvent>[];

  @override
  void record(AppDiagnosticEvent event) => events.add(event);
}

class _SocketProbe {
  _SocketProbe(this.socket) {
    socket.listen((raw) {
      final message = jsonDecode(raw as String) as Map<String, dynamic>;
      final waiter = _waiters.remove(message['type']);
      if (waiter != null) {
        waiter.complete(message);
      } else {
        _pending[message['type'] as String] = message;
      }
    }, onDone: closed.complete);
  }

  final WebSocket socket;
  final Completer<void> closed = Completer<void>();
  final Map<String, Map<String, dynamic>> _pending = {};
  final Map<String, Completer<Map<String, dynamic>>> _waiters = {};

  Future<Map<String, dynamic>> next(String type) {
    final pending = _pending.remove(type);
    if (pending != null) return Future.value(pending);
    final completer = Completer<Map<String, dynamic>>();
    _waiters[type] = completer;
    return completer.future.timeout(const Duration(seconds: 1));
  }
}
