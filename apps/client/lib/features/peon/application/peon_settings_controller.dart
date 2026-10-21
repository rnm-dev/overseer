import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/time/app_time.dart';
import '../domain/peon_settings_models.dart';
import '../domain/peon_settings_repository.dart';

final peonSettingsRepositoryProvider = Provider<PeonSettingsRepository>(
  (ref) => throw StateError(
    'PeonSettingsRepository must be supplied by the composition root.',
  ),
);

final peonSettingsControllerProvider = AsyncNotifierProvider.autoDispose
    .family<PeonSettingsController, PeonSettingsState, PeonSettingsScope>(
      PeonSettingsController.new,
      retry: (_, _) => null,
    );

final peonSettingsPollingPolicyProvider = Provider(
  (ref) => const PeonSettingsPollingPolicy(),
);

class PeonSettingsPollingPolicy {
  const PeonSettingsPollingPolicy({
    this.interval = const Duration(seconds: 2),
    this.maxAttempts = 30,
  });

  final Duration interval;
  final int maxAttempts;
}

class PeonSettingsController extends AsyncNotifier<PeonSettingsState> {
  PeonSettingsController(this.scope);

  final PeonSettingsScope scope;
  late PeonSettingsPollingPolicy _pollingPolicy;
  late AppScheduler _scheduler;

  PeonSettingsRepository get _repository =>
      ref.read(peonSettingsRepositoryProvider);

  @override
  Future<PeonSettingsState> build() async {
    _pollingPolicy = ref.read(peonSettingsPollingPolicyProvider);
    _scheduler = ref.read(appSchedulerProvider);
    if (!scope.online) return const PeonSettingsState();

    final statusFuture = _repository.fetchStatus(scope);
    final catalogFuture = _repository.fetchModelCatalog(scope);
    PeonSettings? settings;
    var unsupported = false;
    String? loadMessage;
    try {
      settings = await _repository.fetchSettings(scope);
    } on PeonSettingsException catch (error) {
      unsupported = error.unsupported;
      loadMessage = error.message;
    }
    return PeonSettingsState(
      settings: settings,
      status: await statusFuture,
      catalog: await catalogFuture,
      unsupported: unsupported,
      loadMessage: loadMessage,
    );
  }

  /// Applies [start], runs [work] and folds its result into state; on a
  /// [PeonSettingsException] applies [fail] with the error message instead.
  Future<bool> _run({
    required PeonSettingsState Function(PeonSettingsState) start,
    required Future<PeonSettingsState Function(PeonSettingsState)> Function()
    work,
    required PeonSettingsState Function(PeonSettingsState, String) fail,
  }) async {
    final current = state.value;
    if (current == null) return false;
    state = AsyncData(start(current));
    try {
      final apply = await work();
      // The work succeeded even if the settings page closed meanwhile.
      if (!ref.mounted) return true;
      state = AsyncData(apply(state.requireValue));
      return true;
    } on PeonSettingsException catch (error) {
      if (!ref.mounted) return false;
      state = AsyncData(fail(state.requireValue, error.message));
      return false;
    }
  }

  Future<bool> saveSettings(Map<String, dynamic> patch) => _run(
    start: (s) => s.copyWith(saving: true, saved: false, clearMessage: true),
    work: () async {
      final settings = await _repository.updateSettings(scope, patch);
      return (PeonSettingsState s) =>
          s.copyWith(settings: settings, saving: false, saved: true);
    },
    fail: (s, message) => s.copyWith(saving: false, message: message),
  );

  Future<bool> saveConnection(String publicUrl) => _run(
    start: (s) => s.copyWith(
      connectionSaving: true,
      connectionSaved: false,
      clearMessage: true,
    ),
    work: () async {
      await _repository.updateConnection(scope, publicUrl);
      return (PeonSettingsState s) =>
          s.copyWith(connectionSaving: false, connectionSaved: true);
    },
    fail: (s, message) => s.copyWith(connectionSaving: false, message: message),
  );

  Future<bool> saveSoul(String soul) => _run(
    start: (s) =>
        s.copyWith(soulSaving: true, soulSaved: false, clearMessage: true),
    work: () async {
      final settings = await _repository.updateSettings(scope, {'soul': soul});
      return (PeonSettingsState s) =>
          s.copyWith(settings: settings, soulSaving: false, soulSaved: true);
    },
    fail: (s, message) => s.copyWith(soulSaving: false, message: message),
  );

  Future<void> checkForUpdate() => _run(
    start: (s) => s.copyWith(checkingUpdate: true, clearMessage: true),
    work: () async {
      final status = await _repository.checkForUpdate(scope);
      return (PeonSettingsState s) =>
          s.copyWith(status: status, checkingUpdate: false);
    },
    fail: (s, message) => s.copyWith(checkingUpdate: false, message: message),
  );

  Future<void> installUpdate() async {
    final installed = await _run(
      start: (s) => s.copyWith(
        updatePhase: PeonUpdatePhase.installing,
        clearMessage: true,
      ),
      work: () async {
        await _repository.installUpdate(scope);
        return (PeonSettingsState s) =>
            s.copyWith(updatePhase: PeonUpdatePhase.restarting);
      },
      fail: (s, message) =>
          s.copyWith(updatePhase: PeonUpdatePhase.idle, message: message),
    );
    if (installed) unawaited(_waitForRestart());
  }

  Future<void> _waitForRestart() async {
    for (var attempt = 0; attempt < _pollingPolicy.maxAttempts; attempt++) {
      await _scheduler.delay(_pollingPolicy.interval);
      if (!ref.mounted) return;
      final status = await _repository.fetchStatus(scope);
      if (!ref.mounted) return;
      if (status != null && !status.updateAvailable) {
        state = AsyncData(
          state.requireValue.copyWith(
            status: status,
            updatePhase: PeonUpdatePhase.complete,
          ),
        );
        return;
      }
    }
    if (!ref.mounted) return;
    state = AsyncData(
      state.requireValue.copyWith(
        updatePhase: PeonUpdatePhase.idle,
        message:
            'The Peon did not come back online after the update. '
            'Check its connection and try again.',
      ),
    );
  }

  Future<bool> deletePeon() => _run(
    start: (s) => s.copyWith(deleting: true, clearMessage: true),
    work: () async {
      await _repository.deletePeon(scope);
      return (PeonSettingsState s) => s;
    },
    fail: (s, message) => s.copyWith(deleting: false, message: message),
  );
}
