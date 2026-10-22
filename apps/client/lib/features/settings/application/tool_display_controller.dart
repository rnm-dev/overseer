import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/tool_display_mode.dart';
import 'enum_preference_controller.dart';

final toolDisplayControllerProvider =
    AsyncNotifierProvider<ToolDisplayController, ToolDisplayMode>(
      ToolDisplayController.new,
    );

class ToolDisplayController extends EnumPreferenceController<ToolDisplayMode> {
  static const preferenceKey = 'overseer.session-tool-display';

  @override
  String get key => preferenceKey;

  @override
  String encode(ToolDisplayMode value) => value.id;

  @override
  ToolDisplayMode decode(String? id) => ToolDisplayMode.fromId(id);
}
