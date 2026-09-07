class ModelCatalogOption {
  const ModelCatalogOption({
    required this.id,
    required this.label,
    this.alias,
    this.isDefault = false,
    this.reasoningEfforts,
  });

  final String id;
  final String label;
  final String? alias;
  final bool isDefault;
  final List<ModelCatalogOption>? reasoningEfforts;

  factory ModelCatalogOption.fromJson(Map<String, dynamic> json) {
    final rawEfforts = json['reasoningEfforts'];
    return ModelCatalogOption(
      id: json['id'] as String? ?? '',
      label: json['label'] as String? ?? json['id'] as String? ?? '',
      alias: json['alias'] as String?,
      isDefault: json['default'] as bool? ?? false,
      reasoningEfforts: rawEfforts is List ? catalogOptions(rawEfforts) : null,
    );
  }
}

class ModelProvider {
  const ModelProvider({
    required this.agent,
    required this.label,
    required this.models,
    required this.reasoningEfforts,
  });

  final String agent;
  final String label;
  final List<ModelCatalogOption> models;
  final List<ModelCatalogOption> reasoningEfforts;

  factory ModelProvider.fromJson(Map<String, dynamic> json) => ModelProvider(
    agent: json['agent'] as String? ?? '',
    label: json['label'] as String? ?? json['agent'] as String? ?? '',
    models: catalogOptions(json['models']),
    reasoningEfforts: catalogOptions(json['reasoningEfforts']),
  );
}

class ModelsCatalog {
  const ModelsCatalog({
    required this.providers,
    this.defaultModel,
    this.defaultAgent,
  });

  final List<ModelProvider> providers;
  final String? defaultModel;
  final String? defaultAgent;

  factory ModelsCatalog.fromJson(Map<String, dynamic> json) => ModelsCatalog(
    providers: (json['providers'] as List? ?? const [])
        .whereType<Map>()
        .map(
          (value) => ModelProvider.fromJson(Map<String, dynamic>.from(value)),
        )
        .where((provider) => provider.agent.isNotEmpty)
        .toList(growable: false),
    defaultModel: json['defaultModel'] as String?,
    defaultAgent: json['defaultAgent'] as String?,
  );
}

ModelProvider? providerForAgent(List<ModelProvider> providers, String? agent) =>
    providers.where((provider) => provider.agent == agent).firstOrNull;

String? effectiveCapability(
  List<ModelCatalogOption> options, {
  String? explicit,
  String? inherited,
}) =>
    explicit ??
    inherited ??
    options.where((option) => option.isDefault).firstOrNull?.id;

String? effectiveReasoningEffort(
  List<ModelCatalogOption> options, {
  String? explicit,
  String? inherited,
}) {
  if (explicit != null) return explicit;
  if (inherited != null &&
      options.any(
        (option) => option.id == inherited || option.alias == inherited,
      )) {
    return inherited;
  }
  return options.where((option) => option.isDefault).firstOrNull?.id;
}

List<ModelCatalogOption> catalogOptions(Object? value) => value is! List
    ? const []
    : value
          .whereType<Map>()
          .map(
            (raw) =>
                ModelCatalogOption.fromJson(Map<String, dynamic>.from(raw)),
          )
          .where((option) => option.id.isNotEmpty)
          .toList(growable: false);

ModelCatalogOption? modelOptionFor(ModelProvider? provider, String? model) {
  if (provider == null || model == null) return null;
  for (final option in provider.models) {
    if (option.id == model || option.alias == model) return option;
  }
  return null;
}

List<ModelCatalogOption> reasoningEffortsForModel(
  ModelProvider? provider,
  String? model,
) {
  if (provider == null) return const [];
  final selected = modelOptionFor(provider, model);
  if (selected == null) return provider.reasoningEfforts;
  final scoped = selected.reasoningEfforts;
  if (scoped != null) return scoped;
  return provider.models.any((option) => option.reasoningEfforts != null)
      ? const []
      : provider.reasoningEfforts;
}
