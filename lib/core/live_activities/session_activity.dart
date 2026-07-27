import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../diagnostics/app_diagnostics.dart';
import '../live/active_sessions.dart';
import '../time/app_time.dart';

final sessionActivityServiceProvider =
    Provider.autoDispose<SessionActivityService>(
      (ref) => const NoopSessionActivityService(),
    );

final sessionActivityCoordinatorProvider =
    Provider.autoDispose<SessionActivityCoordinator>(
      (ref) => SessionActivityCoordinator(
        ref.watch(sessionActivityServiceProvider),
        clock: ref.watch(appClockProvider),
        diagnostics: ref.watch(appDiagnosticsProvider),
      ),
    );

final sessionActivityRegistrationProvider =
    Provider.autoDispose<SessionActivityRegistrationService>(
      (ref) => const NoopSessionActivityRegistrationService(),
    );

class SessionActivitySnapshot {
  const SessionActivitySnapshot({
    required this.connectionId,
    required this.runningCount,
    required this.completedCount,
    required this.updatedAt,
    this.oldestStartedAt,
  });

  final String connectionId;
  final int runningCount;
  final int completedCount;
  final DateTime? oldestStartedAt;
  final DateTime updatedAt;

  String get activityId => 'overseer:$connectionId';

  Map<String, Object?> toMap() => {
    'activityId': activityId,
    'connectionId': connectionId,
    'runningCount': runningCount,
    'completedCount': completedCount,
    if (oldestStartedAt != null)
      'oldestStartedAt': oldestStartedAt!.millisecondsSinceEpoch,
    'updatedAt': updatedAt.millisecondsSinceEpoch,
  };
}

abstract interface class SessionActivityService {
  Stream<SessionActivityPushToken> get pushTokenUpdates;
  Stream<SessionActivityPushToStartToken> get pushToStartTokenUpdates;

  /// Makes the OS surfaces exactly match [activities].
  ///
  /// Implementations must be idempotent so a cold launch can recover
  /// activities created by an earlier app process.
  Future<void> synchronize({
    required String connectionId,
    required List<SessionActivitySnapshot> activities,
  });
}

class NoopSessionActivityService implements SessionActivityService {
  const NoopSessionActivityService();

  @override
  Stream<SessionActivityPushToken> get pushTokenUpdates => const Stream.empty();

  @override
  Stream<SessionActivityPushToStartToken> get pushToStartTokenUpdates =>
      const Stream.empty();

  @override
  Future<void> synchronize({
    required String connectionId,
    required List<SessionActivitySnapshot> activities,
  }) async {}
}

class MethodChannelSessionActivityService implements SessionActivityService {
  MethodChannelSessionActivityService({MethodChannel? channel})
    : _channel =
          channel ??
          const MethodChannel('dev.rnm.overseer/session-activities') {
    _channel.setMethodCallHandler(_handleNativeCall);
    unawaited(_loadPushToStartToken());
  }

  final MethodChannel _channel;
  final _pushTokenUpdates =
      StreamController<SessionActivityPushToken>.broadcast();
  final _pushToStartTokenUpdates =
      StreamController<SessionActivityPushToStartToken>.broadcast();

  @override
  Stream<SessionActivityPushToken> get pushTokenUpdates =>
      _pushTokenUpdates.stream;

  @override
  Stream<SessionActivityPushToStartToken> get pushToStartTokenUpdates =>
      _pushToStartTokenUpdates.stream;

  @override
  Future<void> synchronize({
    required String connectionId,
    required List<SessionActivitySnapshot> activities,
  }) async {
    await _channel.invokeMethod<void>('synchronize', {
      'connectionId': connectionId,
      'activities': [for (final activity in activities) activity.toMap()],
    });
  }

  Future<void> dispose() async {
    _channel.setMethodCallHandler(null);
    await _pushTokenUpdates.close();
    await _pushToStartTokenUpdates.close();
  }

  Future<void> _handleNativeCall(MethodCall call) async {
    if (call.method == 'pushToStartTokenChanged') {
      _addPushToStartToken(call.arguments);
      return;
    }
    if (call.method != 'pushTokenChanged') return;
    final arguments = call.arguments;
    if (arguments is! Map) return;
    final activityId = arguments['activityId'];
    final connectionId = arguments['connectionId'];
    final token = arguments['token'];
    if (activityId is! String ||
        connectionId is! String ||
        token is! String ||
        token.isEmpty) {
      return;
    }
    _pushTokenUpdates.add(
      SessionActivityPushToken(
        activityId: activityId,
        connectionId: connectionId,
        token: token,
      ),
    );
  }

  Future<void> _loadPushToStartToken() async {
    try {
      final token = await _channel.invokeMethod<String>('getPushToStartToken');
      _addPushToStartToken(token);
    } on PlatformException {
      // iOS versions before push-to-start support return no token.
    } on MissingPluginException {
      // The capability remains a no-op on unsupported hosts.
    }
  }

  void _addPushToStartToken(Object? value) {
    final token = switch (value) {
      final String token => token,
      final Map arguments when arguments['token'] is String =>
        arguments['token'] as String,
      _ => null,
    };
    if (token == null || token.isEmpty) return;
    _pushToStartTokenUpdates.add(SessionActivityPushToStartToken(token: token));
  }
}

class SessionActivityPushToken {
  const SessionActivityPushToken({
    required this.activityId,
    required this.connectionId,
    required this.token,
  });

  final String activityId;
  final String connectionId;
  final String token;
}

class SessionActivityPushToStartToken {
  const SessionActivityPushToStartToken({required this.token});

  final String token;
}

abstract interface class SessionActivityRegistrationRemote {
  Future<void> register({
    required String authToken,
    required SessionActivityPushToken activity,
  });

  Future<void> registerPushToStart({
    required String authToken,
    required String connectionId,
    required SessionActivityPushToStartToken token,
  });

  Future<void> deleteAll({required String authToken});
}

class DioSessionActivityRegistrationRemote
    implements SessionActivityRegistrationRemote {
  DioSessionActivityRegistrationRemote({required Uri apiUrl, Dio? dio})
    : _dio =
          dio ??
          Dio(
            BaseOptions(
              baseUrl: apiUrl.toString(),
              connectTimeout: const Duration(seconds: 10),
              receiveTimeout: const Duration(seconds: 10),
            ),
          );

  final Dio _dio;

  @override
  Future<void> register({
    required String authToken,
    required SessionActivityPushToken activity,
  }) async {
    await _dio.put<void>(
      'push/live-activities',
      data: {
        'activityId': activity.activityId,
        'connectionId': activity.connectionId,
        'token': activity.token,
      },
      options: Options(headers: {'Authorization': 'Bearer $authToken'}),
    );
  }

  @override
  Future<void> registerPushToStart({
    required String authToken,
    required String connectionId,
    required SessionActivityPushToStartToken token,
  }) async {
    await _dio.put<void>(
      'push/live-activities/start-token',
      data: {'connectionId': connectionId, 'token': token.token},
      options: Options(headers: {'Authorization': 'Bearer $authToken'}),
    );
  }

  @override
  Future<void> deleteAll({required String authToken}) async {
    await _dio.delete<void>(
      'push/live-activities',
      options: Options(headers: {'Authorization': 'Bearer $authToken'}),
    );
  }
}

abstract interface class SessionActivityRegistrationService {
  Future<void> setAuthToken(String? authToken);

  Future<void> dispose();
}

class NoopSessionActivityRegistrationService
    implements SessionActivityRegistrationService {
  const NoopSessionActivityRegistrationService();

  @override
  Future<void> dispose() async {}

  @override
  Future<void> setAuthToken(String? authToken) async {}
}

class DefaultSessionActivityRegistrationService
    implements SessionActivityRegistrationService {
  DefaultSessionActivityRegistrationService(
    this._activities,
    this._remote, {
    required this.connectionId,
    this._diagnostics = const NoopAppDiagnostics(),
  }) {
    _subscription = _activities.pushTokenUpdates.listen(_register);
    _pushToStartSubscription = _activities.pushToStartTokenUpdates.listen(
      _registerPushToStart,
    );
  }

  final SessionActivityService _activities;
  final SessionActivityRegistrationRemote _remote;
  final String connectionId;
  final AppDiagnostics _diagnostics;
  late final StreamSubscription<SessionActivityPushToken> _subscription;
  late final StreamSubscription<SessionActivityPushToStartToken>
  _pushToStartSubscription;
  final Map<String, SessionActivityPushToken> _latest = {};
  SessionActivityPushToStartToken? _latestPushToStart;
  String? _authToken;
  Future<void> _pending = Future<void>.value();

  @override
  Future<void> setAuthToken(String? authToken) {
    if (authToken == _authToken) return _pending;
    final previous = _authToken;
    _authToken = authToken;
    _pending = _pending
        .catchError((error) {
          _recordRegistrationFailure('previous', error);
        })
        .then((_) async {
          if (authToken == null) {
            if (previous != null) {
              try {
                await _remote.deleteAll(authToken: previous);
              } catch (error) {
                _recordRegistrationFailure('delete', error);
              }
            }
            return;
          }
          final pushToStart = _latestPushToStart;
          if (pushToStart != null) {
            await _registerPushToStartNow(authToken, pushToStart);
          }
          for (final activity in _latest.values) {
            await _registerNow(authToken, activity);
          }
        });
    return _pending;
  }

  void _registerPushToStart(SessionActivityPushToStartToken token) {
    _latestPushToStart = token;
    final authToken = _authToken;
    if (authToken == null) return;
    _pending = _pending
        .catchError((error) {
          _recordRegistrationFailure('previous', error);
        })
        .then((_) => _registerPushToStartNow(authToken, token));
  }

  void _register(SessionActivityPushToken activity) {
    _latest[activity.activityId] = activity;
    final authToken = _authToken;
    if (authToken == null) return;
    _pending = _pending
        .catchError((error) {
          _recordRegistrationFailure('previous', error);
        })
        .then((_) => _registerNow(authToken, activity));
  }

  Future<void> _registerNow(
    String authToken,
    SessionActivityPushToken activity,
  ) async {
    try {
      await _remote.register(authToken: authToken, activity: activity);
    } catch (error) {
      _recordRegistrationFailure('update_token', error);
      // ActivityKit rotates and re-emits tokens. The next authenticated launch
      // and live session update are natural retries.
    }
  }

  Future<void> _registerPushToStartNow(
    String authToken,
    SessionActivityPushToStartToken token,
  ) async {
    try {
      await _remote.registerPushToStart(
        authToken: authToken,
        connectionId: connectionId,
        token: token,
      );
    } catch (error) {
      _recordRegistrationFailure('start_token', error);
      // ActivityKit re-emits rotated tokens. Auth restoration also retries the
      // latest token without delaying application startup.
    }
  }

  void _recordRegistrationFailure(String state, Object error) {
    _diagnostics.record(
      AppDiagnosticEvent(
        name: 'activity.registration',
        level: AppDiagnosticLevel.warning,
        connectionId: connectionId,
        state: state,
        outcome: 'failed',
        errorType: error.runtimeType.toString(),
      ),
    );
  }

  @override
  Future<void> dispose() async {
    await _subscription.cancel();
    await _pushToStartSubscription.cancel();
  }
}

class SessionActivityCoordinator {
  SessionActivityCoordinator(
    this._service, {
    this._clock = const SystemAppClock(),
    this._diagnostics = const NoopAppDiagnostics(),
  });

  final SessionActivityService _service;
  final AppClock _clock;
  final AppDiagnostics _diagnostics;
  String? _lastFingerprint;
  Future<void> _pending = Future<void>.value();

  Future<void> reconcile({
    required String connectionId,
    required Set<String> operatorIdentities,
    required ActiveSessionsState activeSessions,
    required int completedUnreadCount,
    DateTime? now,
  }) {
    final snapshots = _aggregateSnapshot(
      connectionId: connectionId,
      operatorIdentities: operatorIdentities,
      activeSessions: activeSessions,
      completedUnreadCount: completedUnreadCount,
      now: now ?? _clock.now(),
    );
    final fingerprint = snapshots
        .map(
          (item) =>
              '${item.activityId}|${item.runningCount}|'
              '${item.completedCount}|'
              '${item.oldestStartedAt?.millisecondsSinceEpoch}|'
              '${item.updatedAt.millisecondsSinceEpoch}',
        )
        .join('\n');
    if (_lastFingerprint == fingerprint) return _pending;
    _lastFingerprint = fingerprint;
    _pending = _pending
        .catchError((error) {
          _diagnostics.record(
            AppDiagnosticEvent(
              name: 'activity.synchronize',
              level: AppDiagnosticLevel.warning,
              connectionId: connectionId,
              state: 'previous_failed',
              errorType: error.runtimeType.toString(),
            ),
          );
        })
        .then(
          (_) => _service.synchronize(
            connectionId: connectionId,
            activities: snapshots,
          ),
        );
    return _pending;
  }

  List<SessionActivitySnapshot> _aggregateSnapshot({
    required String connectionId,
    required Set<String> operatorIdentities,
    required ActiveSessionsState activeSessions,
    required int completedUnreadCount,
    required DateTime now,
  }) {
    final identities = operatorIdentities
        .map((identity) => identity.trim().toLowerCase())
        .where((identity) => identity.isNotEmpty)
        .toSet();
    if (identities.isEmpty) return const [];
    final owned = <ActiveSession>[];
    final workspaces = activeSessions.authoritativeByWorkspace.entries.toList()
      ..sort((left, right) => left.key.compareTo(right.key));
    for (final entry in workspaces) {
      final sessions = entry.value.sessions.toList()
        ..sort((left, right) => left.sessionId.compareTo(right.sessionId));
      for (final session in sessions) {
        final author = session.author?.trim().toLowerCase();
        if (author == null || !identities.contains(author)) continue;
        owned.add(session);
      }
    }
    if (owned.isEmpty) return const [];
    final startedAt = owned
        .map((session) => _dateFromEpoch(session.startedAt))
        .whereType<DateTime>()
        .fold<DateTime?>(
          null,
          (oldest, value) =>
              oldest == null || value.isBefore(oldest) ? value : oldest,
        );
    final updatedAt = owned
        .map((session) => _dateFromEpoch(session.lastActivityAt))
        .whereType<DateTime>()
        .fold<DateTime?>(
          null,
          (latest, value) =>
              latest == null || value.isAfter(latest) ? value : latest,
        );
    return [
      SessionActivitySnapshot(
        connectionId: connectionId,
        runningCount: owned.length,
        completedCount: completedUnreadCount.clamp(0, 1 << 31),
        oldestStartedAt: startedAt,
        updatedAt: updatedAt ?? now,
      ),
    ];
  }

  static DateTime? _dateFromEpoch(double? epoch) {
    if (epoch == null || epoch <= 0) return null;
    final milliseconds = epoch < 100000000000 ? epoch * 1000 : epoch;
    return DateTime.fromMillisecondsSinceEpoch(milliseconds.round());
  }
}
