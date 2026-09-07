import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/sessions/presentation/capability_choices.dart';
import 'package:overseer_mobile/shared/models/ai_capabilities.dart';

void main() {
  const models = [
    ModelCatalogOption(id: 'gpt-5.6-sol', label: '5.6 Sol', isDefault: true),
    ModelCatalogOption(id: 'gpt-5.6-terra', label: '5.6 Terra'),
  ];

  test('named default remains its explicit wire ID', () {
    final choices = capabilityChoices(models, null);
    expect(choices.map((choice) => choice.value), [
      '',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
    ]);
    expect(choices.first.label, 'Use Peon default');
  });

  test('A B A leaves A explicit instead of inheriting B', () {
    final choices = capabilityChoices(models, 'gpt-5.6-sol');
    expect(
      choices.where((choice) => choice.selected).single.value,
      'gpt-5.6-sol',
    );
  });

  test('reset is separately labelled as session inheritance', () {
    final choices = capabilityChoices(
      models,
      null,
      inherited: 'gpt-5.6-terra',
      resetLabel: 'Use session default',
    );
    expect(choices.first.label, 'Use session default');
    expect(choices.first.selected, isTrue);
  });

  test('effective value never falls back to the first model', () {
    const noDefault = [
      ModelCatalogOption(id: 'first', label: 'First'),
      ModelCatalogOption(id: 'second', label: 'Second'),
    ];
    expect(effectiveCapability(noDefault), isNull);
  });

  test('unknown inherited identity remains visible', () {
    expect(
      capabilityLabel(models, null, inherited: 'retired-model'),
      'retired-model',
    );
  });

  test('provider selection never borrows another provider catalog', () {
    const providers = [
      ModelProvider(
        agent: 'codex',
        label: 'Codex',
        models: models,
        reasoningEfforts: [],
      ),
    ];
    expect(providerForAgent(providers, 'claude'), isNull);
  });

  test(
    'an inherited effort stranded by a model switch uses that model default',
    () {
      const efforts = [
        ModelCatalogOption(id: 'low', label: 'Low', isDefault: true),
      ];
      expect(effectiveReasoningEffort(efforts, inherited: 'high'), 'low');
      expect(
        capabilityLabel(
          efforts,
          null,
          inherited: effectiveReasoningEffort(efforts, inherited: 'high'),
        ),
        'Low',
      );
    },
  );
}
