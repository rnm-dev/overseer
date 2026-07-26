import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('branding graphics stay in the reusable logo widget', () {
    const allowedLogoFiles = <String>{'lib/shared/widgets/overseer_logo.dart'};
    final violations = <String>[];
    final dartFiles = Directory('lib')
        .listSync(recursive: true)
        .whereType<File>()
        .where((file) => file.path.endsWith('.dart'));

    for (final file in dartFiles) {
      final path = file.path.replaceAll(r'\', '/');
      final source = file.readAsStringSync();
      if (source.contains('OverseerLogo') && !allowedLogoFiles.contains(path)) {
        violations.add('$path renders OverseerLogo in product UI');
      }
      if (source.contains('sign-in-hero.png')) {
        violations.add('$path uses decorative sign-in graphics');
      }
    }

    expect(violations, isEmpty, reason: violations.join('\n'));
  });

  test('feature layers preserve dependency boundaries', () {
    final violations = <String>[];
    final publicPresentationDependencies = <String, Set<String>>{};
    final featureFiles = Directory('lib/features')
        .listSync(recursive: true)
        .whereType<File>()
        .where((file) => file.path.endsWith('.dart'));

    for (final file in featureFiles) {
      final path = file.path.replaceAll(r'\', '/');
      final source = file.readAsStringSync();

      if (path.contains('/domain/')) {
        _reject(violations, path, source, const [
          "package:flutter/",
          "/application/",
          "/data/",
          "/presentation/",
        ]);
      }
      if (path.contains('/application/')) {
        _reject(violations, path, source, const [
          "/data/",
          "/presentation/",
          "package:dio/",
          "package:flutter_secure_storage/",
          "package:flutter_web_auth_2/",
          "package:desktop_webview_window/",
        ]);
      }
      if (path.contains('/presentation/')) {
        _reject(violations, path, source, const [
          "/data/",
          "package:dio/",
          "package:flutter_secure_storage/",
          "package:flutter_web_auth_2/",
          "package:desktop_webview_window/",
        ]);
      }
      if (source.contains('Platform.is')) {
        violations.add(
          '$path imports operating-system decisions into a feature',
        );
      }

      final sourceFeature = _featureFor(path);
      if (sourceFeature == null) continue;
      for (final match in _importPattern.allMatches(source)) {
        final target = _resolveImport(path, match.group(1)!);
        final targetFeature = _featureFor(target);
        if (targetFeature == null || targetFeature == sourceFeature) continue;

        if (target.contains('/presentation/') || target.contains('/data/')) {
          violations.add(
            '$path imports internal cross-feature file "$target"; '
            'use features/$targetFeature/$targetFeature.dart',
          );
        }
        if (target == 'lib/features/$targetFeature/$targetFeature.dart') {
          publicPresentationDependencies
              .putIfAbsent(sourceFeature, () => <String>{})
              .add(targetFeature);
        }
      }
    }

    violations.addAll(_dependencyCycles(publicPresentationDependencies));
    expect(violations, isEmpty, reason: violations.join('\n'));
  });
}

final _importPattern = RegExp(r'''(?:import|export)\s+['"]([^'"]+)['"]''');

String _resolveImport(String sourcePath, String importPath) {
  if (importPath.startsWith('package:overseer_mobile/')) {
    return 'lib/${importPath.substring('package:overseer_mobile/'.length)}';
  }
  if (!importPath.startsWith('.')) return importPath;
  final source = Uri.file(File(sourcePath).absolute.path);
  final resolved = source.resolve(importPath).toFilePath();
  return File(resolved).absolute.path
      .replaceFirst('${Directory.current.absolute.path}/', '')
      .replaceAll(r'\', '/');
}

String? _featureFor(String path) {
  final match = RegExp(r'(?:^|/)lib/features/([^/]+)/').firstMatch(path);
  return match?.group(1);
}

List<String> _dependencyCycles(Map<String, Set<String>> dependencies) {
  final violations = <String>[];
  final visited = <String>{};
  final active = <String>[];

  void visit(String feature) {
    final cycleStart = active.indexOf(feature);
    if (cycleStart >= 0) {
      final cycle = [...active.sublist(cycleStart), feature].join(' -> ');
      final message = 'Public feature presentation dependency cycle: $cycle';
      if (!violations.contains(message)) violations.add(message);
      return;
    }
    if (!visited.add(feature)) return;
    active.add(feature);
    for (final dependency in dependencies[feature] ?? const <String>{}) {
      visit(dependency);
    }
    active.removeLast();
  }

  for (final feature in dependencies.keys) {
    visit(feature);
  }
  return violations;
}

void _reject(
  List<String> violations,
  String path,
  String source,
  List<String> forbidden,
) {
  for (final value in forbidden) {
    if (source.contains(value)) {
      violations.add('$path contains forbidden dependency "$value"');
    }
  }
}
