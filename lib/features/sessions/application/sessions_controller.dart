import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/session_models.dart';
import '../domain/session_repository.dart';

final sessionRepositoryProvider = Provider<SessionRepository>(
  (ref) => throw StateError(
    'SessionRepository must be supplied by the application composition root.',
  ),
);

final sessionsControllerProvider = AsyncNotifierProvider.autoDispose
    .family<SessionsController, SessionsState, SessionsScope>(
      SessionsController.new,
      retry: (_, _) => null,
    );

class SessionsScope {
  const SessionsScope({required this.workspaceId, required this.peonId});

  final String workspaceId;
  final String peonId;

  @override
  bool operator ==(Object other) =>
      other is SessionsScope &&
      other.workspaceId == workspaceId &&
      other.peonId == peonId;

  @override
  int get hashCode => Object.hash(workspaceId, peonId);
}

class SessionsState {
  const SessionsState({
    required this.sessions,
    this.isRefreshing = false,
    this.isLoadingMore = false,
    this.hasMore = false,
    this.catalogStale = false,
    this.message,
  });

  final List<SessionSummary> sessions;
  final bool isRefreshing;
  final bool isLoadingMore;
  final bool hasMore;
  final bool catalogStale;
  final String? message;

  SessionsState copyWith({
    List<SessionSummary>? sessions,
    bool? isRefreshing,
    bool? isLoadingMore,
    bool? hasMore,
    bool? catalogStale,
    String? message,
    bool clearMessage = false,
  }) {
    return SessionsState(
      sessions: sessions ?? this.sessions,
      isRefreshing: isRefreshing ?? this.isRefreshing,
      isLoadingMore: isLoadingMore ?? this.isLoadingMore,
      hasMore: hasMore ?? this.hasMore,
      catalogStale: catalogStale ?? this.catalogStale,
      message: clearMessage ? null : message ?? this.message,
    );
  }
}

class SessionsController extends AsyncNotifier<SessionsState> {
  SessionsController(this.scope);

  static const _pageSize = 50;
  static const _reconciliationInterval = Duration(seconds: 5);

  final SessionsScope scope;
  StreamSubscription<List<SessionSummary>>? _subscription;
  Timer? _reconciliationTimer;
  int _nextOffset = 0;

  SessionRepository get _repository => ref.read(sessionRepositoryProvider);

  @override
  Future<SessionsState> build() async {
    final cached = await _repository.loadCachedSessions(
      workspaceId: scope.workspaceId,
      peonId: scope.peonId,
    );
    final stream = _repository.watchSessions(
      workspaceId: scope.workspaceId,
      peonId: scope.peonId,
    );
    _subscription = stream.listen(_applyCachedSessions);
    _reconciliationTimer = Timer.periodic(
      _reconciliationInterval,
      (_) => unawaited(_refresh(reportFailure: false)),
    );
    ref.onDispose(() {
      _reconciliationTimer?.cancel();
      unawaited(_subscription?.cancel());
    });
    Future<void>.microtask(refresh);
    return SessionsState(sessions: cached);
  }

  Future<void> refresh() => _refresh(reportFailure: true);

  Future<void> _refresh({required bool reportFailure}) async {
    final current = state.value;
    if (current == null || current.isRefreshing) return;
    state = AsyncData(current.copyWith(isRefreshing: true, clearMessage: true));
    try {
      final page = await _repository.fetchPage(
        workspaceId: scope.workspaceId,
        peonId: scope.peonId,
        offset: 0,
        limit: _pageSize,
      );
      _nextOffset = page.offset + page.sessions.length;
      final latest = state.value ?? current;
      state = AsyncData(
        latest.copyWith(
          isRefreshing: false,
          hasMore: page.hasMore,
          catalogStale: page.catalogStale,
          clearMessage: true,
        ),
      );
    } on SessionsException catch (error) {
      final latest = state.value ?? current;
      state = AsyncData(
        latest.copyWith(
          isRefreshing: false,
          message: reportFailure ? error.message : null,
          clearMessage: !reportFailure,
        ),
      );
    }
  }

  Future<void> loadMore() async {
    final current = state.value;
    if (current == null ||
        current.isLoadingMore ||
        current.isRefreshing ||
        !current.hasMore) {
      return;
    }
    state = AsyncData(
      current.copyWith(isLoadingMore: true, clearMessage: true),
    );
    try {
      final page = await _repository.fetchPage(
        workspaceId: scope.workspaceId,
        peonId: scope.peonId,
        offset: _nextOffset,
        limit: _pageSize,
      );
      _nextOffset = page.offset + page.sessions.length;
      final latest = state.value ?? current;
      state = AsyncData(
        latest.copyWith(
          isLoadingMore: false,
          hasMore: page.hasMore,
          catalogStale: page.catalogStale,
          clearMessage: true,
        ),
      );
    } on SessionsException catch (error) {
      final latest = state.value ?? current;
      state = AsyncData(
        latest.copyWith(isLoadingMore: false, message: error.message),
      );
    }
  }

  void _applyCachedSessions(List<SessionSummary> sessions) {
    final current = state.value;
    if (current == null) return;
    state = AsyncData(current.copyWith(sessions: sessions));
  }
}
