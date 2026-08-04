import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../application/connection_theme_controller.dart';

class SharedPreferencesConnectionThemeStore implements ConnectionThemeStore {
  static const _selectionPrefix = 'overseer.connection-theme.v1';
  static const _catalogPrefix = 'overseer.connection-theme-catalog.v1';

  @override
  Future<String?> readSelection(String connectionId) async =>
      (await SharedPreferences.getInstance()).getString(
        '$_selectionPrefix.$connectionId',
      );

  @override
  Future<void> writeSelection(String connectionId, String themeId) async {
    await (await SharedPreferences.getInstance()).setString(
      '$_selectionPrefix.$connectionId',
      themeId,
    );
  }

  @override
  Future<Object?> readCatalog(String connectionId) async {
    final raw = (await SharedPreferences.getInstance()).getString(
      '$_catalogPrefix.$connectionId',
    );
    return raw == null ? null : jsonDecode(raw);
  }

  @override
  Future<void> writeCatalog(String connectionId, Object catalog) async {
    await (await SharedPreferences.getInstance()).setString(
      '$_catalogPrefix.$connectionId',
      jsonEncode(catalog),
    );
  }
}
