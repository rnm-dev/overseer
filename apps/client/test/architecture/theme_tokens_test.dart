import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('production UI does not bypass theme tokens', () {
    final violations = <String>[];
    for (final entity in Directory('lib').listSync(recursive: true)) {
      if (entity is! File || !entity.path.endsWith('.dart')) continue;
      final path = entity.path.replaceAll('\\', '/');
      if (_allowlisted(path)) continue;
      final source = entity.readAsStringSync();
      if (source.contains('AppColors.') ||
          RegExp(r'Color\(0x', caseSensitive: false).hasMatch(source) ||
          RegExp(
            r'Colors\.(black|white|grey|red|green|blue|amber|orange)',
          ).hasMatch(source)) {
        violations.add(path);
      }
    }

    expect(violations, isEmpty, reason: violations.join('\n'));
  });
}

bool _allowlisted(String path) =>
    path == 'lib/features/themes/app_theme_package.dart' ||
    path == 'lib/shared/design/colors.dart' ||
    path == 'lib/shared/widgets/file_view_block.dart';
