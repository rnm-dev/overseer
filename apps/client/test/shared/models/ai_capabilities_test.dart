import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/shared/models/ai_capabilities.dart';

void main() {
  test(
    'decodes model-scoped efforts and preserves an authoritative empty list',
    () {
      final catalog = ModelsCatalog.fromJson({
        'defaultAgent': 'claude-code',
        'providers': [
          {
            'agent': 'claude-code',
            'label': 'Claude Code',
            'models': [
              {
                'id': 'opus',
                'label': 'Opus',
                'reasoningEfforts': [
                  {'id': 'high', 'label': 'High', 'default': true},
                ],
              },
              {'id': 'haiku', 'label': 'Haiku', 'reasoningEfforts': []},
            ],
            'reasoningEfforts': [
              {'id': 'high', 'label': 'High'},
            ],
          },
        ],
      });

      final provider = catalog.providers.single;
      expect(reasoningEffortsForModel(provider, 'opus').single.id, 'high');
      expect(reasoningEffortsForModel(provider, 'haiku'), isEmpty);
    },
  );

  test('falls back to provider efforts for an older unscoped catalog', () {
    const provider = ModelProvider(
      agent: 'codex',
      label: 'Codex',
      models: [ModelCatalogOption(id: 'gpt', label: 'GPT')],
      reasoningEfforts: [ModelCatalogOption(id: 'high', label: 'High')],
    );

    expect(reasoningEffortsForModel(provider, 'gpt').single.id, 'high');
  });
}
