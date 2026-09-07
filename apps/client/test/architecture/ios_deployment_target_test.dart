import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('iOS deployment targets stay at 15.0 or later', () {
    final frameworkInfo = File(
      'ios/Flutter/AppFrameworkInfo.plist',
    ).readAsStringSync().replaceAll('\r\n', '\n');
    expect(
      frameworkInfo,
      contains(
        '<key>MinimumOSVersion</key>\n'
        '  <string>15.0</string>',
      ),
    );

    final project = File(
      'ios/Runner.xcodeproj/project.pbxproj',
    ).readAsStringSync();
    final targets = RegExp(r'IPHONEOS_DEPLOYMENT_TARGET = ([0-9.]+);')
        .allMatches(project)
        .map((match) => double.parse(match.group(1)!))
        .toList();

    expect(targets, isNotEmpty);
    expect(targets, everyElement(greaterThanOrEqualTo(15.0)));
  });
}
