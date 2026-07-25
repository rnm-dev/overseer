import 'sound_pack.dart';

abstract interface class WorkSoundPlayer {
  Future<void> play(SoundPack pack);

  Future<void> stop();

  Future<void> dispose();
}

bool isAgentWorkSoundEvent(Map<String, dynamic> payload) {
  final type = payload['type'];
  return type != 'user_message' && type != 'result';
}

class NoopWorkSoundPlayer implements WorkSoundPlayer {
  const NoopWorkSoundPlayer();

  @override
  Future<void> play(SoundPack pack) async {}

  @override
  Future<void> stop() async {}

  @override
  Future<void> dispose() async {}
}

class WorkSoundSelector {
  static const assets = [
    'sounds/sc_scv/work-active-0.wav',
    'sounds/sc_scv/work-active-1.wav',
    'sounds/sc_scv/work-active-2.wav',
    'sounds/sc_scv/work-active-3.wav',
    'sounds/sc_scv/work-active-4.wav',
  ];

  int _previousIndex = -1;
  bool _playing = false;

  String? begin(SoundPack pack, double random) {
    if (pack != SoundPack.scv || _playing) return null;
    var index = (random.clamp(0, 0.999999) * assets.length).floor();
    if (index == _previousIndex && assets.length > 1) {
      index = (index + 1) % assets.length;
    }
    _previousIndex = index;
    _playing = true;
    return assets[index];
  }

  void finish() => _playing = false;

  void stop() => _playing = false;
}
