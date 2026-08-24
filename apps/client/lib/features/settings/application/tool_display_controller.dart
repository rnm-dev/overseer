import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/tool_display_mode.dart';
import '../domain/tool_display_preference_store.dart';

final toolDisplayPreferenceStoreProvider = Provider<ToolDisplayPreferenceStore>(
  (ref) => MemoryToolDisplayPreferenceStore(),
);

final toolDisplayControllerProvider =
    AsyncNotifierProvider<ToolDisplayController, ToolDisplayMode>(
      ToolDisplayController.new,
    );

class ToolDisplayController extends AsyncNotifier<ToolDisplayMode> {
  @override
  Future<ToolDisplayMode> build() {
    return ref.read(toolDisplayPreferenceStoreProvider).read();
  }

  Future<void> select(ToolDisplayMode mode) async {
    final previous = state;
    state = AsyncData(mode);
    try {
      await ref.read(toolDisplayPreferenceStoreProvider).write(mode);
    } catch (error, stackTrace) {
      state = previous;
      Error.throwWithStackTrace(error, stackTrace);
    }
  }
}
