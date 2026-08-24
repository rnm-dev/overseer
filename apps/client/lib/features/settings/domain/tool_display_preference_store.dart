import 'tool_display_mode.dart';

abstract interface class ToolDisplayPreferenceStore {
  Future<ToolDisplayMode> read();

  Future<void> write(ToolDisplayMode mode);
}

class MemoryToolDisplayPreferenceStore implements ToolDisplayPreferenceStore {
  ToolDisplayMode _mode = ToolDisplayMode.technical;

  @override
  Future<ToolDisplayMode> read() async => _mode;

  @override
  Future<void> write(ToolDisplayMode mode) async {
    _mode = mode;
  }
}
