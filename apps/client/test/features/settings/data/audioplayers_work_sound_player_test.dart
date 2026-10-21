import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/settings/data/audioplayers_work_sound_player.dart';

void main() {
  tearDown(() {
    debugDefaultTargetPlatformOverride = null;
  });

  test('does not request Android audio focus', () {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;

    final context = nonInterruptingSoundAudioContext();

    expect(context.android.audioFocus, AndroidAudioFocus.none);
  });

  test('mixes with other audio on iOS', () {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;

    final context = nonInterruptingSoundAudioContext();

    expect(context.iOS.options, contains(AVAudioSessionOptions.mixWithOthers));
  });
}
