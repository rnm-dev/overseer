import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/sound_pack.dart';
import '../domain/sound_preview_player.dart';
import '../domain/work_sound_player.dart';
import 'enum_preference_controller.dart';

final soundPreviewPlayerProvider = Provider<SoundPreviewPlayer>(
  (ref) => const NoopSoundPreviewPlayer(),
);

final workSoundPlayerProvider = Provider<WorkSoundPlayer>(
  (ref) => const NoopWorkSoundPlayer(),
);

final soundPackControllerProvider =
    AsyncNotifierProvider<SoundPackController, SoundPack>(
      SoundPackController.new,
    );

class SoundPackController extends EnumPreferenceController<SoundPack> {
  static const preferenceKey = 'overseer.sound-pack';

  @override
  String get key => preferenceKey;

  @override
  String encode(SoundPack value) => value.id;

  @override
  SoundPack decode(String? id) => SoundPack.fromId(id);

  @override
  Future<void> onSelected(SoundPack value) =>
      ref.read(soundPreviewPlayerProvider).preview(value);
}
