import 'package:shared_preferences/shared_preferences.dart';

import '../domain/sound_pack.dart';
import '../domain/sound_preference_store.dart';

class SharedPreferencesSoundPreferenceStore implements SoundPreferenceStore {
  static const _key = 'overseer.sound-pack';

  @override
  Future<SoundPack> read() async {
    final preferences = await SharedPreferences.getInstance();
    return SoundPack.fromId(preferences.getString(_key));
  }

  @override
  Future<void> write(SoundPack pack) async {
    final preferences = await SharedPreferences.getInstance();
    await preferences.setString(_key, pack.id);
  }
}
