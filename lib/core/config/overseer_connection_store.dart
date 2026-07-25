import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

@immutable
class OverseerConnection {
  const OverseerConnection({
    required this.serverUrl,
    this.usesLegacyStorage = false,
  });

  final Uri serverUrl;
  final bool usesLegacyStorage;

  String get id => serverUrl.toString();
  String get title => serverUrl.host;
}

abstract interface class OverseerConnectionStore {
  Future<List<OverseerConnection>> readAll();

  Future<List<OverseerConnection>> add(Uri serverUrl);
}

class SharedPreferencesOverseerConnectionStore
    implements OverseerConnectionStore {
  static const String preferenceKey = 'overseer.connections';
  static const String legacyPreferenceKey = 'overseer.server_url';

  @override
  Future<List<OverseerConnection>> readAll() async {
    final preferences = await SharedPreferences.getInstance();
    final legacyUrl = parseOverseerServerUrl(
      preferences.getString(legacyPreferenceKey) ?? '',
    );
    final values = <String>[
      ...preferences.getStringList(preferenceKey) ?? const <String>[],
      if (legacyUrl != null) legacyUrl.toString(),
    ];
    final connections = _parseConnections(values, legacyUrl: legacyUrl);

    if (!_sameValues(
      preferences.getStringList(preferenceKey),
      connections.map((connection) => connection.id).toList(),
    )) {
      await _write(preferences, connections);
    }
    return connections;
  }

  @override
  Future<List<OverseerConnection>> add(Uri serverUrl) async {
    final preferences = await SharedPreferences.getInstance();
    final current = await readAll();
    final normalized = normalizeOverseerServerUrl(serverUrl);
    if (current.any((connection) => connection.serverUrl == normalized)) {
      throw const DuplicateOverseerConnectionException();
    }

    final connections = <OverseerConnection>[
      ...current,
      OverseerConnection(serverUrl: normalized),
    ];
    await _write(preferences, connections);
    return connections;
  }

  Future<void> _write(
    SharedPreferences preferences,
    List<OverseerConnection> connections,
  ) async {
    final saved = await preferences.setStringList(
      preferenceKey,
      connections.map((connection) => connection.id).toList(),
    );
    if (!saved) {
      throw StateError('The Overseer connection could not be saved.');
    }
  }

  List<OverseerConnection> _parseConnections(
    List<String> values, {
    required Uri? legacyUrl,
  }) {
    final seen = <String>{};
    final connections = <OverseerConnection>[];
    for (final value in values) {
      final serverUrl = parseOverseerServerUrl(value);
      if (serverUrl == null || !seen.add(serverUrl.toString())) continue;
      connections.add(
        OverseerConnection(
          serverUrl: serverUrl,
          usesLegacyStorage: serverUrl == legacyUrl,
        ),
      );
    }
    return connections;
  }

  bool _sameValues(List<String>? left, List<String> right) {
    if (left == null || left.length != right.length) return false;
    for (var index = 0; index < left.length; index += 1) {
      if (left[index] != right[index]) return false;
    }
    return true;
  }
}

class DuplicateOverseerConnectionException implements Exception {
  const DuplicateOverseerConnectionException();
}

Uri? parseOverseerServerUrl(String value) {
  final candidate = Uri.tryParse(value.trim());
  if (candidate == null ||
      (candidate.scheme != 'https' && candidate.scheme != 'http') ||
      candidate.host.isEmpty ||
      candidate.userInfo.isNotEmpty ||
      candidate.hasQuery ||
      candidate.hasFragment) {
    return null;
  }
  return normalizeOverseerServerUrl(candidate);
}

Uri normalizeOverseerServerUrl(Uri value) {
  var path = value.path;
  while (path.endsWith('/') && path.isNotEmpty) {
    path = path.substring(0, path.length - 1);
  }
  return value.replace(path: path);
}

String overseerConnectionStorageId(Uri serverUrl) {
  final normalized = normalizeOverseerServerUrl(serverUrl).toString();
  return sha256.convert(utf8.encode(normalized)).toString();
}
