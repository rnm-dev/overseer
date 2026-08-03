import 'dart:async';
import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/time/app_time.dart';
import '../domain/plugin_inquiry.dart';
import '../domain/plugin_inquiry_repository.dart';

final pluginInquiryRepositoryProvider = Provider<PluginInquiryRepository>(
  (ref) => throw StateError('PluginInquiryRepository is not configured.'),
);

final pluginInquiryMemoryCacheProvider = Provider<PluginInquiryMemoryCache>(
  (ref) => PluginInquiryMemoryCache(),
);

class PluginInquiryMemoryCache {
  final Map<String, List<PluginInstallInquiry>> _rows = {};
  String _key(PluginInquiryScope scope) =>
      '${scope.workspaceId}\u0000${scope.peonId}\u0000${scope.sessionId}';
  List<PluginInstallInquiry> read(PluginInquiryScope scope) =>
      _rows[_key(scope)] ?? const [];
  void write(PluginInquiryScope scope, List<PluginInstallInquiry> rows) {
    _rows[_key(scope)] = List.unmodifiable(rows);
  }
}

final pluginInquiryControllerProvider = NotifierProvider.autoDispose
    .family<PluginInquiryController, PluginInquiryState, PluginInquiryScope>(
      PluginInquiryController.new,
    );

class PluginInquiryState {
  const PluginInquiryState({
    this.inquiries = const [],
    this.loading = false,
    this.refreshFailed = false,
    this.acting = const {},
    this.actionFailed = const {},
  });

  final List<PluginInstallInquiry> inquiries;
  final bool loading;
  final bool refreshFailed;
  final Set<String> acting;
  final Set<String> actionFailed;

  PluginInquiryState copyWith({
    List<PluginInstallInquiry>? inquiries,
    bool? loading,
    bool? refreshFailed,
    Set<String>? acting,
    Set<String>? actionFailed,
  }) => PluginInquiryState(
    inquiries: inquiries ?? this.inquiries,
    loading: loading ?? this.loading,
    refreshFailed: refreshFailed ?? this.refreshFailed,
    acting: acting ?? this.acting,
    actionFailed: actionFailed ?? this.actionFailed,
  );
}

class PluginInquiryController extends Notifier<PluginInquiryState> {
  PluginInquiryController(this.scope);

  final PluginInquiryScope scope;
  Timer? _poll;
  Timer? _expiry;
  final Map<String, String> _requestIds = {};
  var _refreshVersion = 0;

  @override
  PluginInquiryState build() {
    ref.onDispose(() {
      _poll?.cancel();
      _expiry?.cancel();
    });
    if (!scope.supported) return const PluginInquiryState();
    final now = ref.read(appClockProvider).now();
    final cached = ref
        .read(pluginInquiryMemoryCacheProvider)
        .read(scope)
        .map((row) => row.effectiveAt(now))
        .toList(growable: false);
    _expiry = Timer.periodic(
      const Duration(seconds: 15),
      (_) => _applyExpiry(),
    );
    if (!scope.online) {
      return PluginInquiryState(inquiries: cached, refreshFailed: true);
    }
    _poll = Timer.periodic(const Duration(seconds: 15), (_) => refresh());
    Future<void>.microtask(() => refresh(initial: true));
    return PluginInquiryState(inquiries: cached, loading: cached.isEmpty);
  }

  Future<void> refresh({bool initial = false}) async {
    if (!scope.supported || !scope.online) return;
    final version = ++_refreshVersion;
    if (!initial) state = state.copyWith(refreshFailed: false);
    try {
      final rows = await ref.read(pluginInquiryRepositoryProvider).list(scope);
      if (version != _refreshVersion) return;
      final now = ref.read(appClockProvider).now();
      final effective = rows.map((row) => row.effectiveAt(now)).toList();
      ref.read(pluginInquiryMemoryCacheProvider).write(scope, effective);
      state = state.copyWith(
        inquiries: effective,
        loading: false,
        refreshFailed: false,
      );
    } on Object {
      if (version != _refreshVersion) return;
      state = state.copyWith(loading: false, refreshFailed: true);
    }
  }

  Future<void> respond(
    PluginInstallInquiry inquiry,
    PluginInquiryDecision decision,
  ) async {
    if (!scope.online ||
        !inquiry.status.isActionable ||
        state.acting.contains(inquiry.inquiryId)) {
      return;
    }
    final key = '${inquiry.inquiryId}:${decision.name}';
    _refreshVersion += 1;
    final requestId = _requestIds[key] ??= _newRequestId();
    state = state.copyWith(
      acting: {...state.acting, inquiry.inquiryId},
      actionFailed: {...state.actionFailed}..remove(inquiry.inquiryId),
      inquiries: _replace(
        inquiry.inquiryId,
        inquiry.copyWith(
          status: decision == PluginInquiryDecision.install
              ? PluginInquiryStatus.installing
              : PluginInquiryStatus.cancelled,
        ),
      ),
    );
    try {
      final result = await ref
          .read(pluginInquiryRepositoryProvider)
          .respond(
            scope,
            inquiryId: inquiry.inquiryId,
            decision: decision,
            requestId: requestId,
          );
      _requestIds.remove(key);
      state = state.copyWith(inquiries: _replace(inquiry.inquiryId, result));
      ref.read(pluginInquiryMemoryCacheProvider).write(scope, state.inquiries);
      await refresh();
    } on PluginInquiryException catch (error) {
      if (!error.transient) _requestIds.remove(key);
      state = state.copyWith(
        inquiries: _replace(
          inquiry.inquiryId,
          error.transient
              ? inquiry
              : inquiry.copyWith(status: _statusFor(error.code)),
        ),
        actionFailed: error.transient
            ? {...state.actionFailed, inquiry.inquiryId}
            : state.actionFailed,
      );
    } finally {
      state = state.copyWith(
        acting: {...state.acting}..remove(inquiry.inquiryId),
      );
    }
  }

  List<PluginInstallInquiry> _replace(
    String inquiryId,
    PluginInstallInquiry replacement,
  ) => [
    for (final row in state.inquiries)
      if (row.inquiryId == inquiryId) replacement else row,
  ];

  void _applyExpiry() {
    final now = ref.read(appClockProvider).now();
    state = state.copyWith(
      inquiries: state.inquiries.map((row) => row.effectiveAt(now)).toList(),
    );
  }

  static PluginInquiryStatus _statusFor(String? code) => switch (code) {
    'INQUIRY_EXPIRED' => PluginInquiryStatus.expired,
    'INQUIRY_CANCELLED' ||
    'INQUIRY_ALREADY_CANCELLED' => PluginInquiryStatus.cancelled,
    'INQUIRY_ACTOR_MISMATCH' || 'FORBIDDEN' => PluginInquiryStatus.refused,
    'UNKNOWN_INQUIRY' ||
    'INQUIRY_TURN_ENDED' ||
    'INQUIRY_RUNTIME_LOST' ||
    'INQUIRY_STALE_GENERATION' => PluginInquiryStatus.stale,
    _ => PluginInquiryStatus.failed,
  };

  static String _newRequestId() {
    final random = Random.secure();
    return List.generate(
      16,
      (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
  }
}
