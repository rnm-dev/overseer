import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/fleet/domain/fleet_models.dart';
import 'package:overseer_mobile/features/peon/application/peon_settings_controller.dart';
import 'package:overseer_mobile/features/peon/application/peon_management_controller.dart';
import 'package:overseer_mobile/features/peon/domain/peon_management_models.dart';
import 'package:overseer_mobile/features/peon/domain/peon_management_repository.dart';
import 'package:overseer_mobile/features/peon/domain/peon_settings_models.dart';
import 'package:overseer_mobile/features/peon/domain/peon_settings_repository.dart';
import 'package:overseer_mobile/features/peon/presentation/peon_settings_page.dart';
import 'package:overseer_mobile/shared/design/theme.dart';
import 'package:overseer_mobile/shared/models/ai_capabilities.dart';

void main() {
  testWidgets('renders web-parity General and Agent settings', (tester) async {
    final repository = _FakePeonSettingsRepository();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          peonSettingsRepositoryProvider.overrideWithValue(repository),
          peonManagementRepositoryProvider.overrideWithValue(
            _FakePeonManagementRepository(),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const Scaffold(
            body: PeonSettingsPage(
              workspace: Workspace(id: 'workspace', name: 'Workspace'),
              peon: Peon(
                id: 'peon',
                name: 'Kanat',
                baseUrl: 'https://peon.example',
                addressSource: 'paired',
                online: true,
                lastSeen: 1,
                capabilities: [],
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('peon-settings-general-pane')), findsOneWidget);
    expect(find.text('Peon update'), findsOneWidget);
    expect(find.text('Connection'), findsOneWidget);
    expect(find.text('General settings'), findsOneWidget);
    await tester.drag(
      find.byKey(const Key('peon-settings-general-pane')),
      const Offset(0, -900),
    );
    await tester.pumpAndSettle();
    expect(find.text('DANGER ZONE'), findsOneWidget);

    await tester.tap(find.byKey(const Key('peon-settings-agent')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('peon-settings-agent-pane')), findsOneWidget);
    expect(find.text('Default agent'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('Soul'),
      300,
      scrollable: find.descendant(
        of: find.byKey(const Key('peon-settings-agent-pane')),
        matching: find.byType(Scrollable),
      ),
    );
    expect(find.text('Soul'), findsOneWidget);
    expect(find.byKey(const Key('peon-soul-field')), findsOneWidget);
  });

  testWidgets('keeps connection repair available while offline', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          peonSettingsRepositoryProvider.overrideWithValue(
            _FakePeonSettingsRepository(),
          ),
          peonManagementRepositoryProvider.overrideWithValue(
            _FakePeonManagementRepository(),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const Scaffold(
            body: PeonSettingsPage(
              workspace: Workspace(id: 'workspace', name: 'Workspace'),
              peon: Peon(
                id: 'peon',
                baseUrl: 'http://old-address:4570',
                online: false,
                lastSeen: 1,
                capabilities: [],
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Connection'), findsOneWidget);
    expect(find.byKey(const Key('peon-address-field')), findsOneWidget);
    expect(find.text('General settings'), findsNothing);
  });

  testWidgets(
    'keeps connection and removal available when settings are unsupported',
    (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            peonSettingsRepositoryProvider.overrideWithValue(
              _FakePeonSettingsRepository(
                settingsError: const PeonSettingsException(
                  'Unsupported Peon build.',
                  unsupported: true,
                ),
              ),
            ),
            peonManagementRepositoryProvider.overrideWithValue(
              _FakePeonManagementRepository(),
            ),
          ],
          child: MaterialApp(
            theme: AppTheme.dark,
            home: const Scaffold(
              body: PeonSettingsPage(
                workspace: Workspace(id: 'workspace', name: 'Workspace'),
                peon: Peon(
                  id: 'peon',
                  baseUrl: 'http://peon.example:4570',
                  online: true,
                  lastSeen: 1,
                  capabilities: [],
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Connection'), findsOneWidget);
      expect(
        find.byKey(const Key('peon-settings-retry'), skipOffstage: false),
        findsOneWidget,
      );
      await tester.drag(
        find.byKey(const Key('peon-settings-general-pane')),
        const Offset(0, -900),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('peon-delete-action')), findsOneWidget);
      expect(find.text('General settings'), findsNothing);
    },
  );

  testWidgets('omits an unset name from a partial General patch', (
    tester,
  ) async {
    final repository = _FakePeonSettingsRepository(
      settings: const PeonSettings(
        heartbeatIntervalMs: 5000,
        defaultAgent: 'codex',
      ),
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          peonSettingsRepositoryProvider.overrideWithValue(repository),
          peonManagementRepositoryProvider.overrideWithValue(
            _FakePeonManagementRepository(),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const Scaffold(
            body: PeonSettingsPage(
              workspace: Workspace(id: 'workspace', name: 'Workspace'),
              peon: Peon(
                id: 'peon',
                baseUrl: 'http://peon.example:4570',
                online: true,
                lastSeen: 1,
                capabilities: [],
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.drag(
      find.byKey(const Key('peon-settings-general-pane')),
      const Offset(0, -500),
    );
    await tester.pumpAndSettle();
    await tester.enterText(
      find.descendant(
        of: find.byKey(const Key('peon-heartbeat-field')),
        matching: find.byType(TextField),
      ),
      '6000',
    );
    await tester.tap(find.byKey(const Key('peon-settings-save')).last);
    await tester.pumpAndSettle();

    expect(repository.lastPatch, {'heartbeatIntervalMs': 6000});
  });

  testWidgets('renders cached Armory lifecycle and provider updates', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          peonSettingsRepositoryProvider.overrideWithValue(
            _FakePeonSettingsRepository(),
          ),
          peonManagementRepositoryProvider.overrideWithValue(
            _FakePeonManagementRepository(),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const Scaffold(
            body: PeonSettingsPage(
              workspace: Workspace(
                id: 'workspace',
                name: 'Workspace',
                role: 'owner',
              ),
              peon: Peon(
                id: 'peon',
                name: 'Kanat',
                online: true,
                lastSeen: 1,
                capabilities: [],
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('peon-settings-agent')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('peon-cli-codex')), findsOneWidget);

    await tester.tap(find.byKey(const Key('peon-settings-armory')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('peon-settings-armory-pane')), findsOneWidget);
    expect(find.byKey(const Key('armory-package-cloudflare')), findsOneWidget);
    expect(find.text('Install'), findsOneWidget);
  });
}

class _FakePeonSettingsRepository implements PeonSettingsRepository {
  _FakePeonSettingsRepository({
    this.settings = const PeonSettings(
      name: 'Kanat',
      fileTransferRoot: '/tmp/peon',
      heartbeatIntervalMs: 5000,
      defaultAgent: 'codex',
      soul: 'Careful and precise.',
    ),
    this.settingsError,
  });

  final PeonSettings settings;
  final PeonSettingsException? settingsError;
  Map<String, dynamic>? lastPatch;

  @override
  Future<PeonSettings> fetchSettings(PeonSettingsScope scope) async {
    if (settingsError case final error?) throw error;
    return settings;
  }

  @override
  Future<PeonStatus?> fetchStatus(PeonSettingsScope scope) async =>
      const PeonStatus(updateAvailable: false);

  @override
  Future<ModelsCatalog?> fetchModelCatalog(PeonSettingsScope scope) async =>
      const ModelsCatalog(
        defaultAgent: 'codex',
        providers: [
          ModelProvider(
            agent: 'codex',
            label: 'Codex',
            models: [
              ModelCatalogOption(
                id: 'gpt-5.6',
                label: 'GPT-5.6',
                isDefault: true,
              ),
            ],
            reasoningEfforts: [],
          ),
        ],
      );

  @override
  Future<PeonSettings> updateSettings(
    PeonSettingsScope scope,
    Map<String, dynamic> patch,
  ) {
    lastPatch = patch;
    return Future.value(settings);
  }

  @override
  Future<void> updateConnection(
    PeonSettingsScope scope,
    String publicUrl,
  ) async {}

  @override
  Future<PeonStatus> checkForUpdate(PeonSettingsScope scope) async =>
      const PeonStatus(updateAvailable: false);

  @override
  Future<void> installUpdate(PeonSettingsScope scope) async {}

  @override
  Future<void> deletePeon(PeonSettingsScope scope) async {}
}

class _FakePeonManagementRepository implements PeonManagementRepository {
  static const inventory = ArmoryInventory(
    registry: ArmoryRegistry(source: 'cached', official: true),
    packages: [
      ArmoryPackage(
        id: 'cloudflare',
        available: true,
        updateAvailable: null,
        displayName: 'Cloudflare',
        summary: 'Manage Cloudflare resources.',
        latestVersion: '0.5.2',
      ),
    ],
    total: 1,
  );

  @override
  Future<ArmoryInventory?> loadCachedArmory(PeonSettingsScope scope) async =>
      inventory;

  @override
  Future<ArmoryInventory> fetchArmory(
    PeonSettingsScope scope, {
    bool refresh = false,
  }) async => inventory;

  @override
  Future<List<CliUpdateItem>?> loadCachedCliUpdates(
    PeonSettingsScope scope,
  ) async => const [
    CliUpdateItem(
      provider: CliProvider.codex,
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      updateAvailable: true,
    ),
  ];

  @override
  Future<List<CliUpdateItem>> fetchCliUpdates(
    PeonSettingsScope scope, {
    bool refresh = false,
  }) async => (await loadCachedCliUpdates(scope))!;

  @override
  Future<ArmoryOperation> mutateArmory(
    PeonSettingsScope scope,
    String packageId,
    ArmoryAction action,
  ) async => const ArmoryOperation(
    id: 'operation',
    status: 'success',
    kind: 'install',
  );

  @override
  Future<ArmoryOperation> fetchArmoryOperation(
    PeonSettingsScope scope,
    String operationId,
  ) async => const ArmoryOperation(
    id: 'operation',
    status: 'success',
    kind: 'install',
  );

  @override
  Future<void> startCliUpdate(
    PeonSettingsScope scope,
    CliProvider provider,
  ) async {}
}
