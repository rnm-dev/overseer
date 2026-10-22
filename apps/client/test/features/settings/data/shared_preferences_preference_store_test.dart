import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/settings/application/enum_preference_controller.dart';
import 'package:overseer_mobile/features/settings/application/tool_display_controller.dart';
import 'package:overseer_mobile/features/settings/data/shared_preferences_preference_store.dart';
import 'package:overseer_mobile/features/settings/domain/tool_display_mode.dart';
import 'package:shared_preferences/shared_preferences.dart';

ProviderContainer _container() {
  final container = ProviderContainer(
    overrides: [
      preferenceStoreProvider.overrideWithValue(
        SharedPreferencesPreferenceStore(),
      ),
    ],
  );
  addTearDown(container.dispose);
  return container;
}

void main() {
  test('tool display defaults to technical and persists simple mode', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final container = _container();

    expect(
      await container.read(toolDisplayControllerProvider.future),
      ToolDisplayMode.technical,
    );
    await container
        .read(toolDisplayControllerProvider.notifier)
        .select(ToolDisplayMode.simple);
    expect(
      await SharedPreferencesPreferenceStore().read(
        ToolDisplayController.preferenceKey,
      ),
      ToolDisplayMode.simple.id,
    );
    expect(
      await _container().read(toolDisplayControllerProvider.future),
      ToolDisplayMode.simple,
    );
  });

  test('unknown stored tool display values fail closed to technical', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{
      ToolDisplayController.preferenceKey: 'unknown',
    });

    expect(
      await _container().read(toolDisplayControllerProvider.future),
      ToolDisplayMode.technical,
    );
  });
}
