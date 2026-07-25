import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../features/auth/domain/auth_models.dart';
import '../live/active_sessions.dart';

final sessionActivityServiceProvider = Provider<SessionActivityService>(
  (ref) => const NoopSessionActivityService(),
);

final sessionActivityCoordinatorProvider = Provider<SessionActivityCoordinator>(
  (ref) =>
      SessionActivityCoordinator(ref.watch(sessionActivityServiceProvider)),
);

final sessionActivityRegistrationProvider =
    Provider<SessionActivityRegistrationService>(
      (ref) => const NoopSessionActivityRegistrationService(),
    );

enum SessionActivityPhase {
  queued,
  working,
  waiting,
  needsAttention,
  succeeded,
  failed,
}

class SessionActivitySnapshot {
  const SessionActivitySnapshot({
    required this.workspaceId,
    required this.peonId,
    required this.sessionId,
    required this.title,
    required this.phase,
    required this.updatedAt,
    this.activeCount = 1,
    this.projectName,
    this.detail,
    this.startedAt,
  });

  final String workspaceId;
  final String peonId;
  final String sessionId;
  final String title;
  final int activeCount;
  final String? projectName;
  final String? detail;
  final SessionActivityPhase phase;
  final DateTime? startedAt;
  final DateTime updatedAt;

  String get activityId => '$workspaceId\u0000$peonId\u0000$sessionId';

  Map<String, Object?> toMap() => {
    'activityId': activityId,
    'workspaceId': workspaceId,
    'peonId': peonId,
    'sessionId': sessionId,
    'title': title,
    'activeCount': activeCount,
    if (projectName != null) 'projectName': projectName,
    if (detail != null) 'detail': detail,
    'phase': phase.name,
    if (startedAt != null) 'startedAt': startedAt!.millisecondsSinceEpoch,
    'updatedAt': updatedAt.millisecondsSinceEpoch,
  };
}

abstract interface class SessionActivityService {
  Stream<SessionActivityPushToken> get pushTokenUpdates;

  /// Makes the OS surfaces exactly match [activities].
  ///
  /// Implementations must be idempotent so a cold launch can recover
  /// activities created by an earlier app process.
  Future<void> synchronize(List<SessionActivitySnapshot> activities);
}

class NoopSessionActivityService implements SessionActivityService {
  const NoopSessionActivityService();

  @override
  Stream<SessionActivityPushToken> get pushTokenUpdates => const Stream.empty();

  @override
  Future<void> synchronize(List<SessionActivitySnapshot> activities) async {}
}

class MethodChannelSessionActivityService implements SessionActivityService {
  MethodChannelSessionActivityService({
    this._channel = const MethodChannel('dev.rnm.overseer/session-activities'),
  }) {
    _channel.setMethodCallHandler(_handleNativeCall);
  }

  final MethodChannel _channel;
  final _pushTokenUpdates =
      StreamController<SessionActivityPushToken>.broadcast();

  @override
  Stream<SessionActivityPushToken> get pushTokenUpdates =>
      _pushTokenUpdates.stream;

  @override
  Future<void> synchronize(List<SessionActivitySnapshot> activities) async {
    await _channel.invokeMethod<void>('synchronize', {
      'activities': [for (final activity in activities) activity.toMap()],
    });
  }

  Future<void> dispose() async {
    _channel.setMethodCallHandler(null);
    await _pushTokenUpdates.close();
  }

  Future<void> _handleNativeCall(MethodCall call) async {
    if (call.method != 'pushTokenChanged') return;
    final arguments = call.arguments;
    if (arguments is! Map) return;
    final activityId = arguments['activityId'];
    final workspaceId = arguments['workspaceId'];
    final peonId = arguments['peonId'];
    final sessionId = arguments['sessionId'];
    final token = arguments['token'];
    if (activityId is! String ||
        workspaceId is! String ||
        peonId is! String ||
        sessionId is! String ||
        token is! String ||
        token.isEmpty) {
      return;
    }
    _pushTokenUpdates.add(
      SessionActivityPushToken(
        activityId: activityId,
        workspaceId: workspaceId,
        peonId: peonId,
        sessionId: sessionId,
        token: token,
      ),
    );
  }
}

class SessionActivityPushToken {
  const SessionActivityPushToken({
    required this.activityId,
    required this.workspaceId,
    required this.peonId,
    required this.sessionId,
    required this.token,
  });

  final String activityId;
  final String workspaceId;
  final String peonId;
  final String sessionId;
  final String token;
}

abstract interface class SessionActivityRegistrationRemote {
  Future<void> register({
    required String authToken,
    required SessionActivityPushToken activity,
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
        'workspaceId': activity.workspaceId,
        'peonId': activity.peonId,
        'sessionId': activity.sessionId,
        'token': activity.token,
      },
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
  DefaultSessionActivityRegistrationService(this._activities, this._remote) {
    _subscription = _activities.pushTokenUpdates.listen(_register);
  }

  final SessionActivityService _activities;
  final SessionActivityRegistrationRemote _remote;
  late final StreamSubscription<SessionActivityPushToken> _subscription;
  final Map<String, SessionActivityPushToken> _latest = {};
  String? _authToken;
  Future<void> _pending = Future<void>.value();

  @override
  Future<void> setAuthToken(String? authToken) {
    if (authToken == _authToken) return _pending;
    final previous = _authToken;
    _authToken = authToken;
    _pending = _pending.catchError((_) {}).then((_) async {
      if (authToken == null) {
        if (previous != null) {
          try {
            await _remote.deleteAll(authToken: previous);
          } catch (_) {}
        }
        return;
      }
      for (final activity in _latest.values) {
        await _registerNow(authToken, activity);
      }
    });
    return _pending;
  }

  void _register(SessionActivityPushToken activity) {
    _latest[activity.activityId] = activity;
    final authToken = _authToken;
    if (authToken == null) return;
    _pending = _pending
        .catchError((_) {})
        .then((_) => _registerNow(authToken, activity));
  }

  Future<void> _registerNow(
    String authToken,
    SessionActivityPushToken activity,
  ) async {
    try {
      await _remote.register(authToken: authToken, activity: activity);
    } catch (_) {
      // ActivityKit rotates and re-emits tokens. The next authenticated launch
      // and live session update are natural retries.
    }
  }

  @override
  Future<void> dispose() async {
    await _subscription.cancel();
  }
}

class SessionActivityCoordinator {
  SessionActivityCoordinator(this._service);

  final SessionActivityService _service;
  String? _lastFingerprint;
  Future<void> _pending = Future<void>.value();

  Future<void> reconcile({
    required AuthSession? authSession,
    required ActiveSessionsState activeSessions,
    DateTime? now,
  }) {
    final snapshots = _ownedSnapshots(
      authSession: authSession,
      activeSessions: activeSessions,
      now: now ?? DateTime.now(),
    );
    final fingerprint = snapshots
        .map(
          (item) =>
              '${item.activityId}|${item.title}|${item.projectName}|'
              '${item.detail}|${item.phase.name}|'
              '${item.activeCount}|'
              '${item.startedAt?.millisecondsSinceEpoch}|'
              '${item.updatedAt.millisecondsSinceEpoch}',
        )
        .join('\n');
    if (_lastFingerprint == fingerprint) return _pending;
    _lastFingerprint = fingerprint;
    _pending = _pending
        .catchError((_) {})
        .then((_) => _service.synchronize(snapshots));
    return _pending;
  }

  List<SessionActivitySnapshot> _ownedSnapshots({
    required AuthSession? authSession,
    required ActiveSessionsState activeSessions,
    required DateTime now,
  }) {
    if (authSession == null) return const [];
    final identities = {
      authSession.user.email.trim().toLowerCase(),
      if (authSession.user.githubLogin?.trim().isNotEmpty == true)
        authSession.user.githubLogin!.trim().toLowerCase(),
    };
    final owned = <({String workspaceId, ActiveSession session})>[];
    final workspaces = activeSessions.authoritativeByWorkspace.entries.toList()
      ..sort((left, right) => left.key.compareTo(right.key));
    for (final entry in workspaces) {
      final sessions = entry.value.sessions.toList()
        ..sort((left, right) => left.sessionId.compareTo(right.sessionId));
      for (final session in sessions) {
        final author = session.author?.trim().toLowerCase();
        if (author == null || !identities.contains(author)) continue;
        owned.add((workspaceId: entry.key, session: session));
      }
    }
    return [
      for (final item in owned)
        SessionActivitySnapshot(
          workspaceId: item.workspaceId,
          peonId: item.session.peonId,
          sessionId: item.session.sessionId,
          title: _firstNonEmpty([
            item.session.title,
            item.session.promptPreview,
            item.session.projectKey,
          ], fallback: 'Running session'),
          activeCount: owned.length,
          projectName: _optional(item.session.projectKey),
          detail: _optional(item.session.preview) ?? 'Agent signal is active',
          phase: SessionActivityPhase.working,
          startedAt: _dateFromEpoch(item.session.startedAt),
          updatedAt: _dateFromEpoch(item.session.lastActivityAt) ?? now,
        ),
    ];
  }

  static String _firstNonEmpty(
    Iterable<String?> values, {
    required String fallback,
  }) {
    for (final value in values) {
      final normalized = _optional(value);
      if (normalized != null) return normalized;
    }
    return fallback;
  }

  static String? _optional(String? value) {
    final normalized = value?.trim();
    return normalized == null || normalized.isEmpty ? null : normalized;
  }

  static DateTime? _dateFromEpoch(double? epoch) {
    if (epoch == null || epoch <= 0) return null;
    final milliseconds = epoch < 100000000000 ? epoch * 1000 : epoch;
    return DateTime.fromMillisecondsSinceEpoch(milliseconds.round());
  }
}
