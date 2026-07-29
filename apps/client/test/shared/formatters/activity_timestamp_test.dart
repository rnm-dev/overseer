import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/shared/formatters/activity_timestamp.dart';

void main() {
  group('formatActivityTimestamp', () {
    final now = DateTime(2026, 7, 26, 18, 45);

    test('shows only hours and minutes for today', () {
      final activity = DateTime(2026, 7, 26, 9, 7);

      expect(
        formatActivityTimestamp(
          activity.millisecondsSinceEpoch.toDouble(),
          now: now,
        ),
        '09:07',
      );
    });

    test('shows yesterday and time for the previous calendar day', () {
      final activity = DateTime(2026, 7, 25, 23, 12);

      expect(
        formatActivityTimestamp(
          activity.millisecondsSinceEpoch / 1000,
          now: now,
        ),
        'yesterday, 23:12',
      );
    });

    test('shows a Russian numeric date with year for older activity', () {
      final activity = DateTime(2025, 12, 3, 6, 5);

      expect(
        formatActivityTimestamp(
          activity.millisecondsSinceEpoch.toDouble(),
          now: now,
        ),
        '03.12.2025, 06:05',
      );
    });

    test('does not show missing activity', () {
      expect(formatActivityTimestamp(null, now: now), isNull);
      expect(formatActivityTimestamp(0, now: now), isNull);
    });
  });
}
