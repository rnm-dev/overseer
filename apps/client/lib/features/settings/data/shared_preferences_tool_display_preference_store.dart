import 'package:shared_preferences/shared_preferences.dart';

import '../domain/tool_display_mode.dart';
import '../domain/tool_display_preference_store.dart';

class SharedPreferencesToolDisplayPreferenceStore
    implements ToolDisplayPreferenceStore {
  static const preferenceKey = 'overseer.session-tool-display';

  @override
  Future<ToolDisplayMode> read() async {
    final preferences = await SharedPreferences.getInstance();
    return ToolDisplayMode.fromId(preferences.getString(preferenceKey));
  }

  @override
  Future<void> write(ToolDisplayMode mode) async {
    final preferences = await SharedPreferences.getInstance();
    await preferences.setString(preferenceKey, mode.id);
  }
}
