enum AiStatsPeriod { day, yesterday, week, month }

enum AiProvider {
  codex('codex', 'Codex'),
  claudeCode('claude-code', 'Claude Code');

  const AiProvider(this.apiValue, this.label);

  final String apiValue;
  final String label;
}

extension AiStatsPeriodValue on AiStatsPeriod {
  String get apiValue => name;

  String get label => switch (this) {
    AiStatsPeriod.day => 'Today',
    AiStatsPeriod.yesterday => 'Yesterday',
    AiStatsPeriod.week => 'Week',
    AiStatsPeriod.month => 'Month',
  };
}

class AiModelUsage {
  const AiModelUsage({
    required this.agent,
    required this.model,
    required this.sessionCount,
    required this.totalTokens,
    required this.inputTokens,
    required this.outputTokens,
    required this.totalDurationMs,
    required this.totalCostUsd,
  });

  factory AiModelUsage.fromJson(Map<String, dynamic> json) {
    return AiModelUsage(
      agent: json['agent'] as String? ?? '',
      model: json['model'] as String? ?? '',
      sessionCount: _integer(json['sessionCount']),
      totalTokens: _integer(json['totalTokens']),
      inputTokens: _integer(json['inputTokens'] ?? json['totalInputTokens']),
      outputTokens: _integer(json['outputTokens'] ?? json['totalOutputTokens']),
      totalDurationMs: _integer(json['totalDurationMs']),
      totalCostUsd: _decimal(json['totalCostUsd']),
    );
  }

  final String agent;
  final String model;
  final int sessionCount;
  final int totalTokens;
  final int inputTokens;
  final int outputTokens;
  final int totalDurationMs;
  final double totalCostUsd;

  Map<String, dynamic> toJson() => {
    'agent': agent,
    'model': model,
    'sessionCount': sessionCount,
    'totalTokens': totalTokens,
    'inputTokens': inputTokens,
    'outputTokens': outputTokens,
    'totalDurationMs': totalDurationMs,
    'totalCostUsd': totalCostUsd,
  };
}

class AiStats {
  const AiStats({
    required this.period,
    required this.sessionCount,
    required this.totalInputTokens,
    required this.totalOutputTokens,
    required this.totalCacheCreationTokens,
    required this.totalCacheReadTokens,
    required this.totalTokens,
    required this.totalDurationMs,
    required this.totalCostUsd,
    required this.sessionsMissingUsage,
    required this.byModel,
  });

  factory AiStats.fromJson(Map<String, dynamic> json) {
    final rawModels = json['byModel'];
    return AiStats(
      period: json['period'] as String? ?? '',
      sessionCount: _integer(json['sessionCount']),
      totalInputTokens: _integer(json['totalInputTokens']),
      totalOutputTokens: _integer(json['totalOutputTokens']),
      totalCacheCreationTokens: _integer(json['totalCacheCreationTokens']),
      totalCacheReadTokens: _integer(json['totalCacheReadTokens']),
      totalTokens: _integer(json['totalTokens']),
      totalDurationMs: _integer(json['totalDurationMs']),
      totalCostUsd: _decimal(json['totalCostUsd']),
      sessionsMissingUsage: _integer(json['sessionsMissingUsage']),
      byModel: rawModels is List
          ? rawModels
                .whereType<Map>()
                .map(
                  (item) =>
                      AiModelUsage.fromJson(Map<String, dynamic>.from(item)),
                )
                .toList(growable: false)
          : const [],
    );
  }

  final String period;
  final int sessionCount;
  final int totalInputTokens;
  final int totalOutputTokens;
  final int totalCacheCreationTokens;
  final int totalCacheReadTokens;
  final int totalTokens;
  final int totalDurationMs;
  final double totalCostUsd;
  final int sessionsMissingUsage;
  final List<AiModelUsage> byModel;

  Map<String, dynamic> toJson() => {
    'period': period,
    'sessionCount': sessionCount,
    'totalInputTokens': totalInputTokens,
    'totalOutputTokens': totalOutputTokens,
    'totalCacheCreationTokens': totalCacheCreationTokens,
    'totalCacheReadTokens': totalCacheReadTokens,
    'totalTokens': totalTokens,
    'totalDurationMs': totalDurationMs,
    'totalCostUsd': totalCostUsd,
    'sessionsMissingUsage': sessionsMissingUsage,
    'byModel': byModel.map((model) => model.toJson()).toList(),
  };
}

class AiQuotaWindow {
  const AiQuotaWindow({
    required this.id,
    required this.label,
    required this.usedPercent,
    required this.resetsAt,
    required this.modelIds,
  });

  factory AiQuotaWindow.fromJson(Map<String, dynamic> json) {
    return AiQuotaWindow(
      id: json['id'] as String? ?? '',
      label: json['label'] as String? ?? '',
      usedPercent: _decimal(json['usedPercent']),
      resetsAt: json['resetsAt'] is num
          ? (json['resetsAt'] as num).toInt()
          : null,
      modelIds:
          (json['modelIds'] as List?)?.whereType<String>().toList() ?? const [],
    );
  }

  final String id;
  final String label;
  final double usedPercent;
  final int? resetsAt;
  final List<String> modelIds;
}

class AiProviderQuota {
  const AiProviderQuota({
    required this.provider,
    required this.status,
    required this.updatedAt,
    required this.windows,
    this.source,
    this.accountEmail,
    this.error,
  });

  factory AiProviderQuota.fromJson(Map<String, dynamic> json) {
    final rawWindows = json['windows'];
    return AiProviderQuota(
      provider: json['provider'] as String? ?? '',
      status: json['status'] as String? ?? 'unavailable',
      source: json['source'] as String?,
      updatedAt: _integer(json['updatedAt']),
      accountEmail: json['accountEmail'] as String?,
      windows: rawWindows is List
          ? rawWindows
                .whereType<Map>()
                .map(
                  (item) =>
                      AiQuotaWindow.fromJson(Map<String, dynamic>.from(item)),
                )
                .toList(growable: false)
          : const [],
      error: json['error'] as String?,
    );
  }

  final String provider;
  final String status;
  final String? source;
  final int updatedAt;
  final String? accountEmail;
  final List<AiQuotaWindow> windows;
  final String? error;
}

class AiCapabilityItem {
  const AiCapabilityItem({
    required this.id,
    required this.name,
    required this.enabled,
    this.source,
    this.version,
    this.transport,
  });

  factory AiCapabilityItem.fromJson(Map<String, dynamic> json) {
    return AiCapabilityItem(
      id: json['id'] as String? ?? '',
      name: json['name'] as String? ?? '',
      enabled: json['enabled'] as bool? ?? false,
      source: json['source'] as String?,
      version: json['version'] as String?,
      transport: json['transport'] as String?,
    );
  }

  final String id;
  final String name;
  final bool enabled;
  final String? source;
  final String? version;
  final String? transport;
}

class AiProviderCapabilities {
  const AiProviderCapabilities({
    required this.provider,
    required this.status,
    required this.updatedAt,
    required this.plugins,
    required this.skills,
    required this.mcps,
    this.error,
  });

  factory AiProviderCapabilities.fromJson(Map<String, dynamic> json) {
    List<AiCapabilityItem> items(String key) {
      final raw = json[key];
      return raw is List
          ? raw
                .whereType<Map>()
                .map(
                  (item) => AiCapabilityItem.fromJson(
                    Map<String, dynamic>.from(item),
                  ),
                )
                .toList(growable: false)
          : const [];
    }

    return AiProviderCapabilities(
      provider: json['provider'] as String? ?? '',
      status: json['status'] as String? ?? 'error',
      updatedAt: _integer(json['updatedAt']),
      plugins: items('plugins'),
      skills: items('skills'),
      mcps: items('mcps'),
      error: json['error'] as String?,
    );
  }

  final String provider;
  final String status;
  final int updatedAt;
  final List<AiCapabilityItem> plugins;
  final List<AiCapabilityItem> skills;
  final List<AiCapabilityItem> mcps;
  final String? error;
}

int _integer(Object? value) => value is num ? value.toInt() : 0;

double _decimal(Object? value) => value is num ? value.toDouble() : 0;
