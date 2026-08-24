import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/settings/data/shared_preferences_tool_display_preference_store.dart';
import 'package:overseer_mobile/features/settings/domain/tool_display_mode.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  test('defaults to technical and persists simple mode', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final store = SharedPreferencesToolDisplayPreferenceStore();

    expect(await store.read(), ToolDisplayMode.technical);
    await store.write(ToolDisplayMode.simple);
    expect(await store.read(), ToolDisplayMode.simple);
  });

  test('unknown stored values fail closed to technical', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{
      SharedPreferencesToolDisplayPreferenceStore.preferenceKey: 'unknown',
    });

    expect(
      await SharedPreferencesToolDisplayPreferenceStore().read(),
      ToolDisplayMode.technical,
    );
  });
}
