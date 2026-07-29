class ModelCatalogOption {
  const ModelCatalogOption({
    required this.id,
    required this.label,
    this.alias,
    this.isDefault = false,
  });

  final String id;
  final String label;
  final String? alias;
  final bool isDefault;
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
}
