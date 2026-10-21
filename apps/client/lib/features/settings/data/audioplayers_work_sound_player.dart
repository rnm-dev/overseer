import 'dart:async';
import 'dart:math';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';

import '../domain/sound_pack.dart';
import '../domain/work_sound_player.dart';

/// Audio context that mixes with other audio instead of taking focus.
AudioContext nonInterruptingSoundAudioContext() {
  return AudioContextConfig(
    focus: AudioContextConfigFocus.mixWithOthers,
  ).build();
}

class AudioplayersWorkSoundPlayer implements WorkSoundPlayer {
  AudioplayersWorkSoundPlayer() {
    _completion = _player.onPlayerComplete.listen((_) => _selector.stop());
  }

  final _player = AudioPlayer();
  final _cuePlayer = AudioPlayer();
  final _random = Random();
  final _selector = WorkSoundSelector();
  final _cueSelector = WorkSoundCueSelector();
  late final StreamSubscription<void> _completion;

  @override
  Future<void> play(SoundPack pack) async {
    final asset = _selector.begin(pack, _random.nextDouble());
    if (asset == null) return;
    try {
      await _player.setAudioContext(nonInterruptingSoundAudioContext());
      await _player.play(AssetSource(asset));
    } catch (error) {
      _selector.stop();
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
