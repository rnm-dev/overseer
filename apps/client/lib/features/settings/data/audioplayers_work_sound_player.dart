import 'dart:async';
import 'dart:math';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';

import 'non_interrupting_sound_audio_context.dart';
import '../domain/sound_pack.dart';
import '../domain/work_sound_player.dart';

class AudioplayersWorkSoundPlayer implements WorkSoundPlayer {
  AudioplayersWorkSoundPlayer({
    AudioPlayer? player,
    AudioPlayer? cuePlayer,
    Random? random,
    WorkSoundSelector? selector,
    WorkSoundCueSelector? cueSelector,
  }) : _player = player ?? AudioPlayer(),
       _cuePlayer = cuePlayer ?? AudioPlayer(),
       _random = random ?? Random(),
       _selector = selector ?? WorkSoundSelector(),
       _cueSelector = cueSelector ?? WorkSoundCueSelector() {
    _completion = _player.onPlayerComplete.listen((_) => _selector.finish());
  }

  final AudioPlayer _player;
  final AudioPlayer _cuePlayer;
  final Random _random;
  final WorkSoundSelector _selector;
  final WorkSoundCueSelector _cueSelector;
  late final StreamSubscription<void> _completion;

  @override
  Future<void> play(SoundPack pack) async {
    final asset = _selector.begin(pack, _random.nextDouble());
    if (asset == null) return;
    try {
      await _player.setAudioContext(nonInterruptingSoundAudioContext());
      await _player.play(AssetSource(asset));
    } catch (error) {
      _selector.finish();
      debugPrint(
        '[WorkSound] playback failed pack=${pack.id}: ${error.runtimeType}',
      );
    }
  }

  @override
  Future<void> playCue(SoundPack pack, WorkSoundCue cue) async {
    final asset = _cueSelector.select(pack, cue, _random.nextDouble());
    if (asset == null) return;
    try {
      await _cuePlayer.setAudioContext(nonInterruptingSoundAudioContext());
      await _cuePlayer.play(AssetSource(asset));
    } catch (error) {
      debugPrint(
        '[WorkSound] cue playback failed pack=${pack.id} '
        'cue=${cue.name}: ${error.runtimeType}',
      );
    }
  }

  @override
  Future<void> stop() async {
    _selector.stop();
    try {
      await _player.stop();
    } catch (error) {
      debugPrint('[WorkSound] stop failed: ${error.runtimeType}');
    }
  }

  @override
  Future<void> dispose() async {
    await _completion.cancel();
    await _player.dispose();
    await _cuePlayer.dispose();
  }
}
