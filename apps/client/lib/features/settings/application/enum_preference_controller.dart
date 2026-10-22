import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/preference_store.dart';

final preferenceStoreProvider = Provider<PreferenceStore>(
  (ref) => MemoryPreferenceStore(),
);

/// Persists one enum-valued preference under [key], optimistically updating
/// state and rolling back if the write (or [onSelected]) fails.
abstract class EnumPreferenceController<T extends Enum>
    extends AsyncNotifier<T> {
  String get key;

  String encode(T value);

  T decode(String? id);

  Future<void> onSelected(T value) async {}

  @override
  Future<T> build() async =>
      decode(await ref.read(preferenceStoreProvider).read(key));

  Future<void> select(T value) async {
    final previous = state;
    state = AsyncData(value);
    try {
      // Run both concurrently, but inside the try so a synchronous throw from
      // [onSelected] still rolls back, and a failed write cannot leave the
      // [onSelected] future's error unhandled.
      await Future.wait([
        onSelected(value),
        ref.read(preferenceStoreProvider).write(key, encode(value)),
      ]);
    } catch (error, stackTrace) {
      state = previous;
      Error.throwWithStackTrace(error, stackTrace);
    }
  }
}
