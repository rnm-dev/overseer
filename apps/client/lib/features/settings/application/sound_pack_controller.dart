import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/sound_pack.dart';
import '../domain/sound_preference_store.dart';
import '../domain/sound_preview_player.dart';
import '../domain/work_sound_player.dart';

final soundPreferenceStoreProvider = Provider<SoundPreferenceStore>(
  (ref) => MemorySoundPreferenceStore(),
);

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

class SoundPackController extends AsyncNotifier<SoundPack> {
  @override
  Future<SoundPack> build() {
    return ref.read(soundPreferenceStoreProvider).read();
  }

  Future<void> select(SoundPack pack) async {
    final previous = state;
    state = AsyncData(pack);
    final preview = ref.read(soundPreviewPlayerProvider).preview(pack);
    try {
      await ref.read(soundPreferenceStoreProvider).write(pack);
      await preview;
    } catch (error, stackTrace) {
      state = previous;
      Error.throwWithStackTrace(error, stackTrace);
    }
  }
}
