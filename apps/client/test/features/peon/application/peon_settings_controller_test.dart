import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/peon/application/peon_settings_controller.dart';
import 'package:overseer_mobile/features/peon/domain/peon_settings_models.dart';
import 'package:overseer_mobile/features/peon/domain/peon_settings_repository.dart';
import 'package:overseer_mobile/shared/models/ai_capabilities.dart';

void main() {
  const scope = PeonSettingsScope(
    workspaceId: 'workspace',
    peonId: 'peon',
    online: true,
  );

  test('keeps registry state when remote settings are unsupported', () async {
    final repository = _ControllerRepository(
      settingsError: const PeonSettingsException(
        'Remote settings are unsupported.',
        unsupported: true,
      ),
    );
    final container = ProviderContainer(
      overrides: [peonSettingsRepositoryProvider.overrideWithValue(repository)],
    );
    addTearDown(container.dispose);

    final state = await container.read(
      peonSettingsControllerProvider(scope).future,
    );

    expect(state.settings, isNull);
    expect(state.unsupported, isTrue);
    expect(state.loadMessage, 'Remote settings are unsupported.');
    expect(state.status?.updateAvailable, isTrue);
  });

  test('update polling reaches a terminal timeout state', () async {
    final repository = _ControllerRepository();
    final container = ProviderContainer(
      overrides: [
        peonSettingsRepositoryProvider.overrideWithValue(repository),
        peonSettingsPollingPolicyProvider.overrideWithValue(
          const PeonSettingsPollingPolicy(
            interval: Duration(milliseconds: 1),
            maxAttempts: 1,
          ),
        ),
      ],
    );
    addTearDown(container.dispose);
    final subscription = container.listen(
      peonSettingsControllerProvider(scope),
      (_, _) {},
    );
    addTearDown(subscription.close);
    await container.read(peonSettingsControllerProvider(scope).future);

    await container
        .read(peonSettingsControllerProvider(scope).notifier)
        .installUpdate();
    await Future<void>.delayed(const Duration(milliseconds: 20));
    final state = container
        .read(peonSettingsControllerProvider(scope))
        .requireValue;

    expect(state.updatePhase, PeonUpdatePhase.idle);
    expect(state.message, contains('did not come back online'));
  });

  test('disposing the controller cancels update polling', () async {
    final repository = _ControllerRepository();
    final container = ProviderContainer(
      overrides: [
        peonSettingsRepositoryProvider.overrideWithValue(repository),
        peonSettingsPollingPolicyProvider.overrideWithValue(
          const PeonSettingsPollingPolicy(
            interval: Duration(milliseconds: 50),
            maxAttempts: 2,
          ),
        ),
      ],
    );
    container.listen(peonSettingsControllerProvider(scope), (_, _) {});
    await container.read(peonSettingsControllerProvider(scope).future);
    await container
        .read(peonSettingsControllerProvider(scope).notifier)
        .installUpdate();
    final callsBeforeDispose = repository.statusCalls;

    container.dispose();
    await Future<void>.delayed(const Duration(milliseconds: 70));

    expect(repository.statusCalls, callsBeforeDispose);
  });
}

class _ControllerRepository implements PeonSettingsRepository {
  _ControllerRepository({this.settingsError});

  final PeonSettingsException? settingsError;
  int statusCalls = 0;

  @override
  Future<PeonSettings> fetchSettings(PeonSettingsScope scope) async {
    if (settingsError case final error?) throw error;
    return const PeonSettings(name: 'Nova', heartbeatIntervalMs: 5000);
  }

  @override
  Future<PeonStatus?> fetchStatus(PeonSettingsScope scope) async {
    statusCalls += 1;
    return const PeonStatus(updateAvailable: true);
  }

  @override
  Future<ModelsCatalog?> fetchModelCatalog(PeonSettingsScope scope) async =>
      const ModelsCatalog(providers: []);

  @override
  Future<PeonSettings> updateSettings(
    PeonSettingsScope scope,
    Map<String, dynamic> patch,
  ) => fetchSettings(scope);

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
