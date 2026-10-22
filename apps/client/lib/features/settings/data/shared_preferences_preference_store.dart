import 'package:shared_preferences/shared_preferences.dart';

import '../domain/preference_store.dart';

class SharedPreferencesPreferenceStore implements PreferenceStore {
  @override
  Future<String?> read(String key) async {
    final preferences = await SharedPreferences.getInstance();
    return preferences.getString(key);
  }

  @override
  Future<void> write(String key, String value) async {
    final preferences = await SharedPreferences.getInstance();
    await preferences.setString(key, value);
  }
}
