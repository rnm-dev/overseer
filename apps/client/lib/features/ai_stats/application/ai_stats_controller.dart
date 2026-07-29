import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/ai_stats_models.dart';
import '../domain/ai_stats_repository.dart';

final aiStatsRepositoryProvider = Provider<AiStatsRepository>(
  (ref) => throw StateError(
    'AiStatsRepository must be supplied by the application composition root.',
  ),
);

final aiStatsControllerProvider = AsyncNotifierProvider.autoDispose
    .family<AiStatsController, AiStats, AiStatsScope>(
      AiStatsController.new,
      retry: (_, _) => null,
    );

final aiQuotaControllerProvider = AsyncNotifierProvider.autoDispose
    .family<AiQuotaController, AiProviderQuota, AiProviderScope>(
      AiQuotaController.new,
      retry: (_, _) => null,
    );

final aiCapabilitiesControllerProvider = AsyncNotifierProvider.autoDispose
    .family<AiCapabilitiesController, AiProviderCapabilities, AiProviderScope>(
      AiCapabilitiesController.new,
      retry: (_, _) => null,
    );

class AiStatsScope {
  const AiStatsScope({
    required this.workspaceId,
    required this.peonId,
    required this.period,
    this.online = true,
  });

  final String workspaceId;
  final String peonId;
  final AiStatsPeriod period;
  final bool online;

  @override
  bool operator ==(Object other) =>
      other is AiStatsScope &&
      other.workspaceId == workspaceId &&
      other.peonId == peonId &&
      other.period == period &&
      other.online == online;

  @override
  int get hashCode => Object.hash(workspaceId, peonId, period, online);
}

class AiStatsController extends AsyncNotifier<AiStats> {
  AiStatsController(this.scope);

  final AiStatsScope scope;

  @override
  Future<AiStats> build() async {
    final cached = await ref
        .read(aiStatsRepositoryProvider)
        .loadCachedStats(
          workspaceId: scope.workspaceId,
          peonId: scope.peonId,
          period: scope.period,
        );
    if (cached != null) {
      if (scope.online) Future<void>.microtask(refresh);
      return cached;
    }
    if (!scope.online) {
      throw const AiStatsException(
        'This peon is offline and has no cached statistics.',
      );
    }
    return _load();
  }

  Future<AiStats> _load() {
    return ref
        .read(aiStatsRepositoryProvider)
        .refreshStats(
          workspaceId: scope.workspaceId,
          peonId: scope.peonId,
          period: scope.period,
        );
  }

  Future<void> refresh() async {
    state = const AsyncLoading<AiStats>();
    state = await AsyncValue.guard(_load);
  }
}

class AiProviderScope {
  const AiProviderScope({
    required this.workspaceId,
    required this.peonId,
    required this.provider,
  });

  final String workspaceId;
  final String peonId;
  final AiProvider provider;

  @override
  bool operator ==(Object other) =>
      other is AiProviderScope &&
      other.workspaceId == workspaceId &&
      other.peonId == peonId &&
      other.provider == provider;

  @override
  int get hashCode => Object.hash(workspaceId, peonId, provider);
}

class AiQuotaController extends AsyncNotifier<AiProviderQuota> {
  AiQuotaController(this.scope);

  final AiProviderScope scope;

  @override
  Future<AiProviderQuota> build() => _load();

  Future<AiProviderQuota> _load({bool refresh = false}) {
    return ref
        .read(aiStatsRepositoryProvider)
        .loadQuota(
          workspaceId: scope.workspaceId,
          peonId: scope.peonId,
          provider: scope.provider,
          refresh: refresh,
        );
  }

  Future<void> refresh() async {
    state = const AsyncLoading<AiProviderQuota>();
    state = await AsyncValue.guard(() => _load(refresh: true));
  }
}

class AiCapabilitiesController extends AsyncNotifier<AiProviderCapabilities> {
  AiCapabilitiesController(this.scope);

  final AiProviderScope scope;

  @override
  Future<AiProviderCapabilities> build() => _load();

  Future<AiProviderCapabilities> _load({bool refresh = false}) {
    return ref
        .read(aiStatsRepositoryProvider)
        .loadCapabilities(
          workspaceId: scope.workspaceId,
          peonId: scope.peonId,
          provider: scope.provider,
          refresh: refresh,
        );
  }

  Future<void> refresh() async {
    state = const AsyncLoading<AiProviderCapabilities>();
    state = await AsyncValue.guard(() => _load(refresh: true));
  }
}
