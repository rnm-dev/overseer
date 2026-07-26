import 'sound_pack.dart';

abstract interface class WorkSoundPlayer {
  Future<void> play(SoundPack pack);

  Future<void> playCue(SoundPack pack, WorkSoundCue cue);

  Future<void> stop();

  Future<void> dispose();
}

enum WorkSoundCue { start, stop, complete }

bool isAgentWorkSoundEvent(Map<String, dynamic> payload) {
  final type = payload['type'];
  return type != 'user_message' && type != 'result';
}

class NoopWorkSoundPlayer implements WorkSoundPlayer {
  const NoopWorkSoundPlayer();

  @override
  Future<void> play(SoundPack pack) async {}

  @override
  Future<void> playCue(SoundPack pack, WorkSoundCue cue) async {}

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

class WorkSoundCueSelector {
  static const _assets = <SoundPack, Map<WorkSoundCue, List<String>>>{
    SoundPack.peon: {
      WorkSoundCue.start: [
        'sounds/peon/work-start.wav',
        'sounds/peon/work-start-2.wav',
      ],
      WorkSoundCue.stop: [
        'sounds/peon/work-stop.wav',
        'sounds/peon/work-stop-2.wav',
      ],
      WorkSoundCue.complete: [
        'sounds/peon/work-complete.wav',
        'sounds/peon/work-start.wav',
      ],
    },
    SoundPack.scv: {
      WorkSoundCue.start: [
        'sounds/sc_scv/work-start.mp3',
        'sounds/sc_scv/work-start-2.mp3',
      ],
      WorkSoundCue.stop: [
        'sounds/sc_scv/work-stop.mp3',
        'sounds/sc_scv/work-stop-2.mp3',
      ],
      WorkSoundCue.complete: [
        'sounds/sc_scv/work-complete.mp3',
        'sounds/sc_scv/work-complete-2.mp3',
      ],
    },
    SoundPack.peasant: {
      WorkSoundCue.start: [
        'sounds/peasant/work-start.wav',
        'sounds/peasant/work-start-2.wav',
      ],
      WorkSoundCue.stop: [
        'sounds/peasant/work-stop.wav',
        'sounds/peasant/work-stop-2.wav',
      ],
      WorkSoundCue.complete: [
        'sounds/peasant/work-complete.wav',
        'sounds/peasant/work-complete-2.wav',
      ],
    },
  };

  String? select(SoundPack pack, WorkSoundCue cue, double random) {
    final candidates = _assets[pack]?[cue];
    if (candidates == null || candidates.isEmpty) return null;
    final index = (random.clamp(0, 0.999999) * candidates.length).floor();
    return candidates[index];
  }
}
