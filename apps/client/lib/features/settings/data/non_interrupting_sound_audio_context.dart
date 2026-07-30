import 'package:audioplayers/audioplayers.dart';

AudioContext nonInterruptingSoundAudioContext() {
  return AudioContextConfig(
    focus: AudioContextConfigFocus.mixWithOthers,
  ).build();
}
