import 'dart:async';
import 'dart:math';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';

import '../domain/sound_pack.dart';
import '../domain/work_sound_player.dart';

class AudioplayersWorkSoundPlayer implements WorkSoundPlayer {
  AudioplayersWorkSoundPlayer({
    AudioPlayer? player,
    Random? random,
    WorkSoundSelector? selector,
  }) : _player = player ?? AudioPlayer(),
       _random = random ?? Random(),
       _selector = selector ?? WorkSoundSelector() {
    _completion = _player.onPlayerComplete.listen((_) => _selector.finish());
  }

  final AudioPlayer _player;
  final Random _random;
  final WorkSoundSelector _selector;
  late final StreamSubscription<void> _completion;

  @override
  Future<void> play(SoundPack pack) async {
    final asset = _selector.begin(pack, _random.nextDouble());
    if (asset == null) return;
    try {
      await _player.play(AssetSource(asset));
    } catch (error) {
      _selector.finish();
      debugPrint(
        '[WorkSound] playback failed pack=${pack.id}: ${error.runtimeType}',
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
  }
}
