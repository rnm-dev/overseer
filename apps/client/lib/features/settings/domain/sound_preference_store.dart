import 'sound_pack.dart';

abstract interface class SoundPreferenceStore {
  Future<SoundPack> read();

  Future<void> write(SoundPack pack);
}

class MemorySoundPreferenceStore implements SoundPreferenceStore {
  SoundPack _pack = SoundPack.peon;

  @override
  Future<SoundPack> read() async => _pack;

  @override
  Future<void> write(SoundPack pack) async {
    _pack = pack;
  }
}
