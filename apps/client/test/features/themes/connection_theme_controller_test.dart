import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/themes/application/connection_theme_controller.dart';
import 'package:overseer_mobile/features/themes/app_theme_package.dart';

void main() {
  test('bundled registry mirrors the web package order and fallback', () {
    expect(AppThemePackages.bundled.map((theme) => theme.id), const [
      'org.overseer.ironwood',
      'org.overseer.parchment',
      'org.overseer.sterling',
      'org.overseer.neon-nocturne',
      'org.overseer.amber-terminal',
      'org.overseer.candy-static',
    ]);
    expect(AppThemePackages.resolve(null).id, AppThemePackages.defaultId);
    expect(AppThemePackages.resolve('unknown').id, AppThemePackages.defaultId);
  });

  test('selection persists by Overseer connection and restores', () async {
    final store = MemoryConnectionThemeStore();
    final first = ConnectionThemeController(connectionId: 'dev', store: store);
    await first.select(AppThemePackages.resolve('org.overseer.parchment'));

    final restored = ConnectionThemeController(
      connectionId: 'dev',
      store: store,
    );
    await restored.load();
    final production = ConnectionThemeController(
      connectionId: 'production',
      store: store,
    );
    await production.load();

    expect(restored.theme.id, 'org.overseer.parchment');
    expect(production.theme.id, AppThemePackages.defaultId);
  });

  test('failed persistence rolls optimistic selection back', () async {
    final controller = ConnectionThemeController(
      connectionId: 'dev',
      store: _FailingStore(),
    );

    await expectLater(
      controller.select(AppThemePackages.resolve('org.overseer.sterling')),
      throwsStateError,
    );
    expect(controller.theme.id, AppThemePackages.defaultId);
  });

  test('valid server catalog replaces the snapshot and is cached', () async {
    final store = MemoryConnectionThemeStore();
    final catalog = _catalog(
      _manifest(id: 'org.overseer.remote', name: 'Remote'),
    );
    final controller = ConnectionThemeController(
      connectionId: 'dev',
      store: store,
      source: _Source(catalog),
    );
    await controller.load();

    expect(controller.themes.map((theme) => theme.id), [
      AppThemePackages.defaultId,
      'org.overseer.remote',
    ]);
    expect(store.catalogs['dev'], same(catalog));
  });

  test('invalid remote catalog keeps the cached catalog', () async {
    final store = MemoryConnectionThemeStore();
    final cached = _catalog(
      _manifest(id: 'org.overseer.cached', name: 'Cached'),
    );
    store.catalogs['dev'] = cached;
    final controller = ConnectionThemeController(
      connectionId: 'dev',
      store: store,
      source: _Source({'format': 'evil', 'themes': []}),
    );
    await controller.load();
    expect(controller.themes.map((theme) => theme.id), [
      AppThemePackages.defaultId,
      'org.overseer.cached',
    ]);
  });
}

class _FailingStore implements ConnectionThemeStore {
  @override
  Future<String?> readSelection(String connectionId) async => null;

  @override
  Future<void> writeSelection(String connectionId, String themeId) async {
    throw StateError('blocked');
  }

  @override
  Future<Object?> readCatalog(String connectionId) async => null;

  @override
  Future<void> writeCatalog(String connectionId, Object catalog) async {}
}

class _Source implements ConnectionThemeCatalogSource {
  const _Source(this.value);
  final Object value;
  @override
  Future<Object?> fetch() async => value;
}

Map<String, Object> _catalog(Map<String, Object> extra) => {
  'format': 'overseer-theme-v1',
  'defaultThemeId': AppThemePackages.defaultId,
  'themes': [
    _manifest(id: AppThemePackages.defaultId, name: 'Ironwood'),
    extra,
  ],
};

Map<String, Object> _manifest({required String id, required String name}) => {
  'format': 'overseer-theme-v1',
  'id': id,
  'name': name,
  'appearance': 'dark',
  'tokens': {
    '--ov-canvas': '#0b0c0b',
    '--ov-surface': '#111311',
    '--ov-surface-raised': '#171916',
    '--ov-surface-hover': '#262a23',
    '--ov-surface-active': '#343931',
    '--ov-edge': '#262a23',
    '--ov-edge-strong': '#343931',
    '--ov-ink': '#e7e6dc',
    '--ov-ink-muted': '#9a9c8e',
    '--ov-ink-faint': '#64685a',
    '--ov-accent': '#86ab63',
    '--ov-accent-strong': '#a6c78a',
    '--ov-accent-deep': '#5c7a41',
    '--ov-accent-muted': '#3a4b2a',
    '--ov-on-accent': '#0b1305',
    '--ov-warning': '#d99441',
    '--ov-warning-strong': '#e6b877',
    '--ov-warning-deep': '#8d5624',
    '--ov-danger': '#d95f48',
    '--ov-danger-deep': '#a53a29',
  },
};
