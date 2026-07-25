import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:overseer_mobile/features/settings/application/sound_pack_controller.dart';
import 'package:overseer_mobile/features/settings/domain/sound_pack.dart';
import 'package:overseer_mobile/features/settings/domain/sound_preference_store.dart';
import 'package:overseer_mobile/features/settings/domain/sound_preview_player.dart';

void main() {
  test('persists a selection and previews the selected pack', () async {
    final store = MemorySoundPreferenceStore();
    final preview = _RecordingSoundPreviewPlayer();
    final container = ProviderContainer(
      overrides: [
        soundPreferenceStoreProvider.overrideWithValue(store),
        soundPreviewPlayerProvider.overrideWithValue(preview),
      ],
    );
    addTearDown(container.dispose);

    expect(
      await container.read(soundPackControllerProvider.future),
      SoundPack.peon,
    );

    await container
        .read(soundPackControllerProvider.notifier)
        .select(SoundPack.scv);

    expect(container.read(soundPackControllerProvider).value, SoundPack.scv);
    expect(await store.read(), SoundPack.scv);
    expect(preview.previews, [SoundPack.scv]);
  });

  test('mute is sent to the player so active preview playback stops', () async {
    final preview = _RecordingSoundPreviewPlayer();
    final container = ProviderContainer(
      overrides: [soundPreviewPlayerProvider.overrideWithValue(preview)],
    );
    addTearDown(container.dispose);
    await container.read(soundPackControllerProvider.future);

    await container
        .read(soundPackControllerProvider.notifier)
        .select(SoundPack.mute);

    expect(preview.previews, [SoundPack.mute]);
  });
}

class _RecordingSoundPreviewPlayer implements SoundPreviewPlayer {
  final previews = <SoundPack>[];

  @override
  Future<void> preview(SoundPack pack) async {
    previews.add(pack);
  }

  @override
  Future<void> dispose() async {}
}
