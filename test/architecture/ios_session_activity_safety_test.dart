import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('iOS Live Activity reconciliation tolerates duplicate activity IDs', () {
    final source = File(
      'ios/Runner/SessionActivityPlugin.swift',
    ).readAsStringSync();

    expect(
      source,
      isNot(contains('uniqueKeysWithValues: Activity<')),
      reason:
          'Persisted or legacy Live Activities can share an activity ID. '
          'Dictionary(uniqueKeysWithValues:) traps on duplicate keys.',
    );
    expect(
      source,
      contains('grouping: Activity<OverseerSessionAttributes>.activities'),
    );
    expect(source, contains('matchingActivities.dropFirst()'));
    expect(source, contains('dismissalPolicy: .immediate'));
  });
}
