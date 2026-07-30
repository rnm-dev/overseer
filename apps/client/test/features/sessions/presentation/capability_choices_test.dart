import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/sessions/presentation/capability_choices.dart';
import 'package:overseer_mobile/shared/models/ai_capabilities.dart';

void main() {
  const models = [
    ModelCatalogOption(id: 'gpt-5.6-sol', label: '5.6 Sol', isDefault: true),
    ModelCatalogOption(id: 'gpt-5.6-terra', label: '5.6 Terra'),
  ];
  const unmarked = [
    ModelCatalogOption(id: 'gpt-5.6-sol', label: '5.6 Sol'),
    ModelCatalogOption(id: 'gpt-5.6-terra', label: '5.6 Terra'),
  ];

  test('the inherited option is listed once instead of beside itself', () {
    final choices = capabilityChoices(models, null);
    expect(choices.map((choice) => choice.label), [
      '5.6 Sol · Default',
      '5.6 Terra',
    ]);
  });

  test('an unset override selects the inherited option', () {
    final choices = capabilityChoices(models, null);
    expect(choices.map((choice) => choice.selected), [true, false]);
    expect(choices.first.name, '5.6 Sol');
  });

  test('picking the inherited option stays uncommitted', () {
    final choices = capabilityChoices(models, null);
    expect(choices.first.value, '');
    expect(choices.last.value, 'gpt-5.6-terra');
  });

  test("a session's own pick outranks the provider's marked default", () {
    final choices = capabilityChoices(models, null, inherited: 'gpt-5.6-terra');
    expect(choices.map((choice) => choice.label), [
      '5.6 Sol',
      '5.6 Terra · Default',
    ]);
    expect(choices.map((choice) => choice.selected), [false, true]);
  });

  test('an explicit override wins over the inherited option', () {
    final choices = capabilityChoices(models, 'gpt-5.6-terra');
    expect(choices.map((choice) => choice.selected), [false, true]);
  });

  test('an override naming the inherited option selects that one row', () {
    final choices = capabilityChoices(models, 'gpt-5.6-sol');
    expect(choices.map((choice) => choice.selected), [true, false]);
  });

  test('a provider marking no default keeps a plain unset row', () {
    final choices = capabilityChoices(unmarked, null);
    expect(choices.map((choice) => choice.label), [
      'Default',
      '5.6 Sol',
      '5.6 Terra',
    ]);
    expect(choices.first.selected, isTrue);
    expect(choices.first.value, '');
  });

  test('an alias names the same option as the id', () {
    const aliased = [
      ModelCatalogOption(id: 'claude-opus-5', label: 'Opus 5', alias: 'opus'),
    ];
    final choices = capabilityChoices(aliased, null, inherited: 'opus');
    expect(choices.single.label, 'Opus 5 · Default');
    expect(choices.single.selected, isTrue);
  });

  test('the chip names the option in force rather than saying Default', () {
    expect(capabilityLabel(models, null), '5.6 Sol');
    expect(capabilityLabel(models, 'gpt-5.6-terra'), '5.6 Terra');
    expect(capabilityLabel(unmarked, null), 'Default');
    expect(
      capabilityLabel(unmarked, null, inherited: 'gpt-5.6-terra'),
      '5.6 Terra',
    );
  });

  test('a value naming nothing listed is shown as it stands', () {
    expect(capabilityLabel(models, 'retired-model'), 'retired-model');
    final choices = capabilityChoices(models, 'retired-model');
    expect(choices.every((choice) => !choice.selected), isTrue);
  });
}
