import '../../../shared/models/ai_capabilities.dart';

/// One row of the composer's model / effort sheet.
class CapabilityChoice {
  const CapabilityChoice({
    required this.value,
    required this.label,
    required this.name,
    required this.selected,
  });

  /// What the sheet reports when this row is picked. An empty string means
  /// "nothing of my own", which is what picking the inherited option means.
  final String value;

  /// The row text, which marks the inherited option as the default.
  final String label;

  /// The plain option name, which is what the closed chip shows.
  final String name;

  final bool selected;
}

/// One row per actual choice. The option an unset override falls back to is
/// listed once and marked, instead of appearing both as a "Default" row and
/// again in the list below it — those were the same choice under two names.
///
/// [inherited] is what the session already pinned; when it names nothing in
/// [options] the provider's own marked default takes over. Only when neither
/// exists — a provider that marks no default, which both Codex providers ship
/// as today — is a plain [fallbackLabel] row the one way to say "unset".
List<CapabilityChoice> capabilityChoices(
  List<ModelCatalogOption> options,
  String? value, {
  String? inherited,
  String fallbackLabel = 'Default',
}) {
  // By index rather than by instance: const options with the same fields are
  // canonicalised to one object, so identity would not tell two rows apart.
  final fallback = _indexOf(options, inherited) ?? _markedDefault(options);
  final selected = value == null ? fallback : _indexOf(options, value);
  final choices = [
    for (var i = 0; i < options.length; i++)
      CapabilityChoice(
        // Picking the inherited option means the composer keeps following the
        // peon rather than pinning whatever the default happens to be today.
        value: i == fallback ? '' : options[i].id,
        label: i == fallback
            ? '${options[i].label} · $fallbackLabel'
            : options[i].label,
        name: options[i].label,
        selected: i == selected,
      ),
  ];
  if (fallback == null) {
    choices.insert(
      0,
      CapabilityChoice(
        value: '',
        label: fallbackLabel,
        name: fallbackLabel,
        selected: value == null,
      ),
    );
  }
  return choices;
}

/// What the closed chip shows for a capability: the selected option's plain
/// name, or [fallbackLabel] while nothing is selected and nothing is inherited.
String capabilityLabel(
  List<ModelCatalogOption> options,
  String? value, {
  String? inherited,
  String fallbackLabel = 'Default',
}) {
  for (final choice in capabilityChoices(
    options,
    value,
    inherited: inherited,
    fallbackLabel: fallbackLabel,
  )) {
    if (choice.selected) return choice.name;
  }
  return value ?? fallbackLabel;
}

int? _indexOf(List<ModelCatalogOption> options, String? value) {
  if (value == null || value.isEmpty) return null;
  for (var i = 0; i < options.length; i++) {
    if (options[i].id == value || options[i].alias == value) return i;
  }
  return null;
}

int? _markedDefault(List<ModelCatalogOption> options) {
  for (var i = 0; i < options.length; i++) {
    if (options[i].isDefault) return i;
  }
  return null;
}
