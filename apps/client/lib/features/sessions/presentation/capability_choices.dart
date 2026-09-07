import '../../../shared/models/ai_capabilities.dart';

/// One row of the composer's model / effort sheet.
class CapabilityChoice {
  const CapabilityChoice({
    required this.value,
    required this.label,
    required this.name,
    required this.selected,
  });

  /// A named option is always its real wire ID. The sole empty value is the
  /// separately-labelled inherit/reset action.
  final String value;
  final String label;
  final String name;
  final bool selected;
}

/// Actual choices are always explicit pins. Reset is a separate action, so
/// choosing A after A → B submits A rather than silently inheriting B.
List<CapabilityChoice> capabilityChoices(
  List<ModelCatalogOption> options,
  String? value, {
  String? inherited,
  String resetLabel = 'Use Peon default',
}) => [
  CapabilityChoice(
    value: '',
    label: resetLabel,
    name: resetLabel,
    selected: value == null,
  ),
  for (final option in options)
    CapabilityChoice(
      value: option.id,
      label: option.label,
      name: option.label,
      selected: value == option.id || value == option.alias,
    ),
];

String capabilityLabel(
  List<ModelCatalogOption> options,
  String? value, {
  String? inherited,
  String fallbackLabel = '',
}) {
  final effective = effectiveCapability(
    options,
    explicit: value,
    inherited: inherited,
  );
  if (effective == null) {
    return fallbackLabel;
  }
  for (final option in options) {
    if (option.id == effective || option.alias == effective) {
      return option.label;
    }
  }
  return effective;
}
