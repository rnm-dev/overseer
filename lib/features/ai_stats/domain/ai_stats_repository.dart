import 'ai_stats_models.dart';

abstract interface class AiStatsRepository {
  Future<AiStats?> loadCachedStats({
    required String workspaceId,
    required String peonId,
    required AiStatsPeriod period,
  });

  Future<AiStats> refreshStats({
    required String workspaceId,
    required String peonId,
    required AiStatsPeriod period,
  });

  Future<AiProviderQuota> loadQuota({
    required String workspaceId,
    required String peonId,
    required AiProvider provider,
    bool refresh = false,
  });

  Future<AiProviderCapabilities> loadCapabilities({
    required String workspaceId,
    required String peonId,
    required AiProvider provider,
    bool refresh = false,
  });
}

class AiStatsException implements Exception {
  const AiStatsException(this.message, {this.unsupported = false});

  final String message;
  final bool unsupported;

  @override
  String toString() => message;
}
