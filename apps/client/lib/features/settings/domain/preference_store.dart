/// Key/value store for small string-encoded user preferences.
abstract interface class PreferenceStore {
  Future<String?> read(String key);

  Future<void> write(String key, String value);
}

class MemoryPreferenceStore implements PreferenceStore {
  final Map<String, String> _values = {};

  @override
  Future<String?> read(String key) async => _values[key];

  @override
  Future<void> write(String key, String value) async {
    _values[key] = value;
  }
}
