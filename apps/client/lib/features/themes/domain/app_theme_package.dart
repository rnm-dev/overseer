import 'package:flutter/material.dart';

@immutable
class AppThemePackage {
  const AppThemePackage({
    required this.id,
    required this.name,
    required this.appearance,
    required this.canvas,
    required this.surface,
    required this.surfaceRaised,
    required this.surfaceHover,
    required this.surfaceActive,
    required this.edge,
    required this.edgeStrong,
    required this.ink,
    required this.inkMuted,
    required this.inkFaint,
    required this.accent,
    required this.accentStrong,
    required this.accentDeep,
    required this.accentMuted,
    required this.onAccent,
    required this.warning,
    required this.warningStrong,
    required this.warningDeep,
    required this.danger,
    required this.dangerDeep,
  });

  final String id;
  final String name;
  final Brightness appearance;
  final Color canvas;
  final Color surface;
  final Color surfaceRaised;
  final Color surfaceHover;
  final Color surfaceActive;
  final Color edge;
  final Color edgeStrong;
  final Color ink;
  final Color inkMuted;
  final Color inkFaint;
  final Color accent;
  final Color accentStrong;
  final Color accentDeep;
  final Color accentMuted;
  final Color onAccent;
  final Color warning;
  final Color warningStrong;
  final Color warningDeep;
  final Color danger;
  final Color dangerDeep;

  static AppThemePackage? fromManifest(Object? value) {
    if (value is! Map) return null;
    final map = Map<String, Object?>.from(value);
    if (map['format'] != 'overseer-theme-v1' ||
        map['id'] is! String ||
        map['name'] is! String) {
      return null;
    }
    final appearance = switch (map['appearance']) {
      'dark' => Brightness.dark,
      'light' => Brightness.light,
      _ => null,
    };
    final rawTokens = map['tokens'];
    if (appearance == null || rawTokens is! Map || rawTokens.length > 96) {
      return null;
    }
    final tokens = Map<String, Object?>.from(rawTokens);
    Color? color(String name) {
      final raw = tokens[name];
      if (raw is! String || !RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(raw)) {
        return null;
      }
      return Color(int.parse('ff${raw.substring(1)}', radix: 16));
    }

    final required = <Color?>[
      color('--ov-canvas'),
      color('--ov-surface'),
      color('--ov-surface-raised'),
      color('--ov-surface-hover'),
      color('--ov-surface-active'),
      color('--ov-edge'),
      color('--ov-edge-strong'),
      color('--ov-ink'),
      color('--ov-ink-muted'),
      color('--ov-ink-faint'),
      color('--ov-accent'),
      color('--ov-accent-strong'),
      color('--ov-accent-deep'),
      color('--ov-accent-muted'),
      color('--ov-on-accent'),
      color('--ov-warning'),
      color('--ov-warning-strong'),
      color('--ov-warning-deep'),
      color('--ov-danger'),
      color('--ov-danger-deep'),
    ];
    if (required.any((item) => item == null)) return null;
    return AppThemePackage(
      id: map['id']! as String,
      name: map['name']! as String,
      appearance: appearance,
      canvas: required[0]!,
      surface: required[1]!,
      surfaceRaised: required[2]!,
      surfaceHover: required[3]!,
      surfaceActive: required[4]!,
      edge: required[5]!,
      edgeStrong: required[6]!,
      ink: required[7]!,
      inkMuted: required[8]!,
      inkFaint: required[9]!,
      accent: required[10]!,
      accentStrong: required[11]!,
      accentDeep: required[12]!,
      accentMuted: required[13]!,
      onAccent: required[14]!,
      warning: required[15]!,
      warningStrong: required[16]!,
      warningDeep: required[17]!,
      danger: required[18]!,
      dangerDeep: required[19]!,
    );
  }
}

@immutable
class AppThemePalette extends ThemeExtension<AppThemePalette> {
  const AppThemePalette(this.package);

  final AppThemePackage package;

  @override
  AppThemePalette copyWith({AppThemePackage? package}) =>
      AppThemePalette(package ?? this.package);

  @override
  AppThemePalette lerp(covariant AppThemePalette? other, double t) =>
      t < 0.5 || other == null ? this : other;
}

abstract final class AppThemePackages {
  static const defaultId = 'org.overseer.ironwood';

  static const bundled = <AppThemePackage>[
    AppThemePackage(
      id: defaultId,
      name: 'Ironwood',
      appearance: Brightness.dark,
      canvas: Color(0xff0b0c0b),
      surface: Color(0xff111311),
      surfaceRaised: Color(0xff171916),
      surfaceHover: Color(0xff262a23),
      surfaceActive: Color(0xff343931),
      edge: Color(0xff262a23),
      edgeStrong: Color(0xff343931),
      ink: Color(0xffe7e6dc),
      inkMuted: Color(0xff9a9c8e),
      inkFaint: Color(0xff64685a),
      accent: Color(0xff86ab63),
      accentStrong: Color(0xffa6c78a),
      accentDeep: Color(0xff5c7a41),
      accentMuted: Color(0xff3a4b2a),
      onAccent: Color(0xff0b1305),
      warning: Color(0xffd99441),
      warningStrong: Color(0xffe6b877),
      warningDeep: Color(0xff8d5624),
      danger: Color(0xffd95f48),
      dangerDeep: Color(0xffa53a29),
    ),
    AppThemePackage(
      id: 'org.overseer.parchment',
      name: 'Parchment',
      appearance: Brightness.light,
      canvas: Color(0xfff3efe4),
      surface: Color(0xfffaf7ef),
      surfaceRaised: Color(0xffffffff),
      surfaceHover: Color(0xffe9e2d3),
      surfaceActive: Color(0xffddd3c1),
      edge: Color(0xffd7cbb6),
      edgeStrong: Color(0xffb7a88f),
      ink: Color(0xff272a24),
      inkMuted: Color(0xff5f6258),
      inkFaint: Color(0xff7a7b70),
      accent: Color(0xff597c3c),
      accentStrong: Color(0xff3f6724),
      accentDeep: Color(0xff36531f),
      accentMuted: Color(0xffdce8cf),
      onAccent: Color(0xffffffff),
      warning: Color(0xffa45f20),
      warningStrong: Color(0xff87490f),
      warningDeep: Color(0xff713b0d),
      danger: Color(0xffb33e31),
      dangerDeep: Color(0xff8f2c23),
    ),
    AppThemePackage(
      id: 'org.overseer.sterling',
      name: 'Sterling',
      appearance: Brightness.light,
      canvas: Color(0xfff5f6f7),
      surface: Color(0xffffffff),
      surfaceRaised: Color(0xffffffff),
      surfaceHover: Color(0xffeef0f2),
      surfaceActive: Color(0xffe2e5e8),
      edge: Color(0xffdce1e5),
      edgeStrong: Color(0xffc2cad1),
      ink: Color(0xff202428),
      inkMuted: Color(0xff596168),
      inkFaint: Color(0xff7a838b),
      accent: Color(0xff58758d),
      accentStrong: Color(0xff3f627e),
      accentDeep: Color(0xff304d64),
      accentMuted: Color(0xffdce6ed),
      onAccent: Color(0xffffffff),
      warning: Color(0xff9a6828),
      warningStrong: Color(0xff7b501b),
      warningDeep: Color(0xff684116),
      danger: Color(0xffb2473f),
      dangerDeep: Color(0xff8e352f),
    ),
    AppThemePackage(
      id: 'org.overseer.neon-nocturne',
      name: 'Neon Nocturne',
      appearance: Brightness.dark,
      canvas: Color(0xff08071a),
      surface: Color(0xff100d29),
      surfaceRaised: Color(0xff171238),
      surfaceHover: Color(0xff221a4a),
      surfaceActive: Color(0xff30235d),
      edge: Color(0xff3a2d68),
      edgeStrong: Color(0xff315f83),
      ink: Color(0xfff3f1ff),
      inkMuted: Color(0xffaaa4c6),
      inkFaint: Color(0xff706b91),
      accent: Color(0xff28c6dc),
      accentStrong: Color(0xff70efff),
      accentDeep: Color(0xff177b9b),
      accentMuted: Color(0xff17445c),
      onAccent: Color(0xff07151d),
      warning: Color(0xffa8e54b),
      warningStrong: Color(0xffd2ff72),
      warningDeep: Color(0xff5c8d26),
      danger: Color(0xffff647c),
      dangerDeep: Color(0xffb52d54),
    ),
    AppThemePackage(
      id: 'org.overseer.amber-terminal',
      name: 'Amber Terminal',
      appearance: Brightness.dark,
      canvas: Color(0xff0c0905),
      surface: Color(0xff120d07),
      surfaceRaised: Color(0xff191108),
      surfaceHover: Color(0xff241b10),
      surfaceActive: Color(0xff30271a),
      edge: Color(0xff493014),
      edgeStrong: Color(0xff4f7164),
      ink: Color(0xfff0c56c),
      inkMuted: Color(0xffb38b46),
      inkFaint: Color(0xff73582e),
      accent: Color(0xffe5a83a),
      accentStrong: Color(0xffffd277),
      accentDeep: Color(0xff9d681d),
      accentMuted: Color(0xff4d3212),
      onAccent: Color(0xff1a0f03),
      warning: Color(0xff58b99d),
      warningStrong: Color(0xff8bd9c0),
      warningDeep: Color(0xff2d725f),
      danger: Color(0xffe36845),
      dangerDeep: Color(0xff9a3f28),
    ),
    AppThemePackage(
      id: 'org.overseer.candy-static',
      name: 'Candy Static',
      appearance: Brightness.light,
      canvas: Color(0xfffff8ed),
      surface: Color(0xfffffdf8),
      surfaceRaised: Color(0xffffffff),
      surfaceHover: Color(0xfff2ecff),
      surfaceActive: Color(0xffe4dbff),
      edge: Color(0xff252234),
      edgeStrong: Color(0xff171522),
      ink: Color(0xff171522),
      inkMuted: Color(0xff575166),
      inkFaint: Color(0xff81798d),
      accent: Color(0xfff2309b),
      accentStrong: Color(0xffd70b7d),
      accentDeep: Color(0xffa60761),
      accentMuted: Color(0xffffd6eb),
      onAccent: Color(0xffffffff),
      warning: Color(0xff3257d6),
      warningStrong: Color(0xff193dbd),
      warningDeep: Color(0xff17328e),
      danger: Color(0xffe33a43),
      dangerDeep: Color(0xffaf202b),
    ),
  ];

  static AppThemePackage resolve(String? id) => bundled.firstWhere(
    (theme) => theme.id == id,
    orElse: () => bundled.first,
  );
}
