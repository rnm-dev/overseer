import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../app_theme_package.dart';

abstract interface class ConnectionThemeStore {
  Future<String?> readSelection(String connectionId);
  Future<void> writeSelection(String connectionId, String themeId);
  Future<Object?> readCatalog(String connectionId);
  Future<void> writeCatalog(String connectionId, Object catalog);
}

abstract interface class ConnectionThemeCatalogSource {
  Future<Object?> fetch();
}

class MemoryConnectionThemeStore implements ConnectionThemeStore {
  final Map<String, String> selections = {};
  final Map<String, Object> catalogs = {};

  @override
  Future<String?> readSelection(String connectionId) async =>
      selections[connectionId];
  @override
  Future<void> writeSelection(String connectionId, String themeId) async =>
      selections[connectionId] = themeId;
  @override
  Future<Object?> readCatalog(String connectionId) async =>
      catalogs[connectionId];
  @override
  Future<void> writeCatalog(String connectionId, Object catalog) async =>
      catalogs[connectionId] = catalog;
}

class UnavailableConnectionThemeCatalogSource
    implements ConnectionThemeCatalogSource {
  const UnavailableConnectionThemeCatalogSource();
  @override
  Future<Object?> fetch() =>
      Future.error(StateError('Theme catalog unavailable'));
}

final connectionThemeStoreProvider = Provider<ConnectionThemeStore>(
  (ref) => MemoryConnectionThemeStore(),
);
final connectionThemeCatalogSourceProvider =
    Provider<ConnectionThemeCatalogSource>(
      (ref) => const UnavailableConnectionThemeCatalogSource(),
    );
final themeConnectionIdProvider = Provider<String>((ref) => 'default');

final connectionThemeControllerProvider = Provider<ConnectionThemeController>((
  ref,
) {
  final controller = ConnectionThemeController(
    connectionId: ref.watch(themeConnectionIdProvider),
    store: ref.watch(connectionThemeStoreProvider),
    source: ref.watch(connectionThemeCatalogSourceProvider),
  );
  controller.load();
  ref.onDispose(controller.dispose);
  return controller;
});

class ConnectionThemeController extends ChangeNotifier {
  ConnectionThemeController({
    required this.connectionId,
    required this.store,
    this.source = const UnavailableConnectionThemeCatalogSource(),
  });

  final String connectionId;
  final ConnectionThemeStore store;
  final ConnectionThemeCatalogSource source;
  AppThemePackage _theme = AppThemePackages.bundled.first;
  List<AppThemePackage> _themes = AppThemePackages.bundled;
  String _selectedId = AppThemePackages.defaultId;

  AppThemePackage get theme => _theme;
  List<AppThemePackage> get themes => List.unmodifiable(_themes);

  Future<void> load() async {
    try {
      _selectedId =
          await store.readSelection(connectionId) ?? AppThemePackages.defaultId;
    } catch (_) {
      _selectedId = AppThemePackages.defaultId;
    }
    try {
      final cached = _parseCatalog(await store.readCatalog(connectionId));
      if (cached != null) _themes = cached;
    } catch (_) {
      // The compiled snapshot remains authoritative when cache is unreadable.
    }
    _theme = _resolve(_selectedId);
    notifyListeners();

    try {
      final raw = await source.fetch();
      final remote = _parseCatalog(raw);
      if (remote == null) return;
      _themes = remote;
      _theme = _resolve(_selectedId);
      notifyListeners();
      if (raw != null) await store.writeCatalog(connectionId, raw);
    } catch (_) {
      // Offline and incompatible servers keep the cached/compiled catalog.
    }
  }

  Future<void> select(AppThemePackage theme) async {
    final previous = _theme;
    final previousId = _selectedId;
    _selectedId = theme.id;
    _theme = _resolve(theme.id);
    notifyListeners();
    try {
      await store.writeSelection(connectionId, theme.id);
    } catch (_) {
      _selectedId = previousId;
      _theme = previous;
      notifyListeners();
      rethrow;
    }
  }

  AppThemePackage _resolve(String id) => _themes.firstWhere(
    (theme) => theme.id == id,
    orElse: () => _themes.firstWhere(
      (theme) => theme.id == AppThemePackages.defaultId,
      orElse: () => AppThemePackages.bundled.first,
    ),
  );

  static List<AppThemePackage>? _parseCatalog(Object? value) {
    if (value is! Map) return null;
    final map = Map<String, Object?>.from(value);
    if (map['format'] != 'overseer-theme-v1' ||
        map['defaultThemeId'] != AppThemePackages.defaultId) {
      return null;
    }
    final rawThemes = map['themes'];
    if (rawThemes is! List || rawThemes.isEmpty || rawThemes.length > 32) {
      return null;
    }
    final themes = rawThemes.map(AppThemePackage.fromManifest).toList();
    if (themes.any((theme) => theme == null)) return null;
    final valid = themes.cast<AppThemePackage>();
    if (!valid.any((theme) => theme.id == AppThemePackages.defaultId) ||
        valid.map((theme) => theme.id).toSet().length != valid.length) {
      return null;
    }
    return valid;
  }
}
