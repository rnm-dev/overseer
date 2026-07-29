import 'sound_pack.dart';

abstract interface class SoundPreviewPlayer {
  Future<void> preview(SoundPack pack);

  Future<void> dispose();
}

class NoopSoundPreviewPlayer implements SoundPreviewPlayer {
  const NoopSoundPreviewPlayer();

  @override
  Future<void> preview(SoundPack pack) async {}

  @override
  Future<void> dispose() async {}
}
