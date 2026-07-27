import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('iOS Live Activity palette stays aligned with the Flutter UI kit', () {
    final flutterColors = _readHexColors(
      File('lib/shared/design/colors.dart').readAsStringSync(),
      RegExp(r'static const Color (\w+) = Color\(0xFF([0-9A-Fa-f]{6})\);'),
    );
    final activityColors = _readHexColors(
      File(
        'ios/SessionActivityWidget/SessionActivityWidget.swift',
      ).readAsStringSync(),
      RegExp(r'static let (\w+) = Color\(hex: 0x([0-9A-Fa-f]{6})\)'),
    );

    const sharedTokens = {
      'voidColor',
      'iron800',
      'fel',
      'felBright',
      'felDeep',
      'forge',
      'blood',
      'bone',
      'boneDim',
      'boneFaint',
    };

    expect(
      activityColors.keys,
      containsAll(sharedTokens),
      reason: 'The native widget should use semantic Overseer color tokens.',
    );
    for (final token in sharedTokens) {
      expect(
        activityColors[token],
        flutterColors[token],
        reason: '$token must match AppColors.$token.',
      );
    }
  });
}

Map<String, String> _readHexColors(String source, RegExp pattern) {
  return {
    for (final match in pattern.allMatches(source))
      match.group(1)!: match.group(2)!.toUpperCase(),
  };
}
