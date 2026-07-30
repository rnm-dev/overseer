import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';

import 'non_interrupting_sound_audio_context.dart';
import '../domain/sound_pack.dart';
import '../domain/sound_preview_player.dart';

class AudioplayersSoundPreviewPlayer implements SoundPreviewPlayer {
  AudioplayersSoundPreviewPlayer({AudioPlayer? player})
    : _player = player ?? AudioPlayer();

  final AudioPlayer _player;

  @override
  Future<void> preview(SoundPack pack) async {
    try {
      await _player.stop();
      final asset = pack.previewAsset;
      if (asset == null) return;
      await _player.setAudioContext(nonInterruptingSoundAudioContext());
      await _player.play(AssetSource(asset));
    } catch (error) {
      debugPrint(
        '[SoundPreview] playback failed pack=${pack.id}: '
        '${error.runtimeType}',
      );
    }
  }

  @override
  Future<void> dispose() => _player.dispose();
}
