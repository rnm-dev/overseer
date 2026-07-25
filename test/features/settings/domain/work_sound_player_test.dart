import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/settings/domain/sound_pack.dart';
import 'package:overseer_mobile/features/settings/domain/work_sound_player.dart';

void main() {
  test('only non-terminal agent events request a working sound', () {
    expect(isAgentWorkSoundEvent({'type': 'assistant'}), isTrue);
    expect(isAgentWorkSoundEvent({'type': 'user'}), isTrue);
    expect(isAgentWorkSoundEvent({'type': 'system'}), isTrue);
    expect(isAgentWorkSoundEvent({'type': 'user_message'}), isFalse);
    expect(isAgentWorkSoundEvent({'type': 'result'}), isFalse);
  });

  test('working sounds are exclusive to the SCV pack', () {
    final selector = WorkSoundSelector();

    expect(selector.begin(SoundPack.peon, 0), isNull);
    expect(selector.begin(SoundPack.peasant, 0), isNull);
    expect(selector.begin(SoundPack.mute, 0), isNull);
    expect(selector.begin(SoundPack.scv, 0), WorkSoundSelector.assets.first);
  });

  test('does not overlap active clips', () {
    final selector = WorkSoundSelector();

    expect(selector.begin(SoundPack.scv, 0), isNotNull);
    expect(selector.begin(SoundPack.scv, 0.5), isNull);
    selector.finish();
    expect(selector.begin(SoundPack.scv, 0.5), isNotNull);
  });

  test('does not repeat the previous clip', () {
    final selector = WorkSoundSelector();

    expect(selector.begin(SoundPack.scv, 0), WorkSoundSelector.assets[0]);
    selector.finish();
    expect(selector.begin(SoundPack.scv, 0), WorkSoundSelector.assets[1]);
  });

  test('stop releases the overlap gate', () {
    final selector = WorkSoundSelector();

    expect(selector.begin(SoundPack.scv, 0), isNotNull);
    selector.stop();
    expect(selector.begin(SoundPack.scv, 0.5), isNotNull);
  });
}
