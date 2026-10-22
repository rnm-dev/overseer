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
    .family<
      AiProviderController<AiProviderQuota>,
      AiProviderQuota,
      AiProviderScope
    >(
      (scope) => AiProviderController(
        scope,
        (repository, scope, {required refresh}) => repository.loadQuota(
          workspaceId: scope.workspaceId,
          peonId: scope.peonId,
          provider: scope.provider,
          refresh: refresh,
        ),
      ),
      retry: (_, _) => null,
    );

final aiCapabilitiesControllerProvider = AsyncNotifierProvider.autoDispose
    .family<
      AiProviderController<AiProviderCapabilities>,
      AiProviderCapabilities,
      AiProviderScope
    >(
      (scope) => AiProviderController(
        scope,
        (repository, scope, {required refresh}) => repository.loadCapabilities(
          workspaceId: scope.workspaceId,
          peonId: scope.peonId,
          provider: scope.provider,
          refresh: refresh,
        ),
      ),
      retry: (_, _) => null,
    );

typedef AiStatsScope = ({
  String workspaceId,
  String peonId,
  AiStatsPeriod period,
  bool online,
});

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

typedef AiProviderScope = ({
  String workspaceId,
  String peonId,
  AiProvider provider,
});

typedef AiProviderLoader<T> =
    Future<T> Function(
      AiStatsRepository repository,
      AiProviderScope scope, {
      required bool refresh,
    });

/// Loads one provider-scoped resource (quota or capabilities) and supports a
/// forced refresh.
class AiProviderController<T> extends AsyncNotifier<T> {
  AiProviderController(this.scope, this._loader);

  final AiProviderScope scope;
  final AiProviderLoader<T> _loader;

  @override
  Future<T> build() => _load();

  Future<T> _load({bool refresh = false}) =>
      _loader(ref.read(aiStatsRepositoryProvider), scope, refresh: refresh);

  Future<void> refresh() async {
    state = AsyncLoading<T>();
    state = await AsyncValue.guard(() => _load(refresh: true));
  }
}
