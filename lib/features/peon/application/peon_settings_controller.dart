import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

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
  final Completer<void> _disposed = Completer<void>();
  late PeonSettingsPollingPolicy _pollingPolicy;

  PeonSettingsRepository get _repository =>
      ref.read(peonSettingsRepositoryProvider);

  @override
  Future<PeonSettingsState> build() async {
    _pollingPolicy = ref.read(peonSettingsPollingPolicyProvider);
    ref.onDispose(() {
      if (!_disposed.isCompleted) _disposed.complete();
    });
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

  Future<bool> saveSettings(Map<String, dynamic> patch) async {
    final current = state.value;
    if (current == null) return false;
    state = AsyncData(
      current.copyWith(saving: true, saved: false, clearMessage: true),
    );
    try {
      final settings = await _repository.updateSettings(scope, patch);
      state = AsyncData(
        state.requireValue.copyWith(
          settings: settings,
          saving: false,
          saved: true,
        ),
      );
      return true;
    } on PeonSettingsException catch (error) {
      state = AsyncData(
        state.requireValue.copyWith(saving: false, message: error.message),
      );
      return false;
    }
  }

  Future<bool> saveConnection(String publicUrl) async {
    final current = state.value;
    if (current == null) return false;
    state = AsyncData(
      current.copyWith(
        connectionSaving: true,
        connectionSaved: false,
        clearMessage: true,
      ),
    );
    try {
      await _repository.updateConnection(scope, publicUrl);
      state = AsyncData(
        state.requireValue.copyWith(
          connectionSaving: false,
          connectionSaved: true,
        ),
      );
      return true;
    } on PeonSettingsException catch (error) {
      state = AsyncData(
        state.requireValue.copyWith(
          connectionSaving: false,
          message: error.message,
        ),
      );
      return false;
    }
  }

  Future<bool> saveSoul(String soul) async {
    final current = state.value;
    if (current == null) return false;
    state = AsyncData(
      current.copyWith(soulSaving: true, soulSaved: false, clearMessage: true),
    );
    try {
      final settings = await _repository.updateSettings(scope, {'soul': soul});
      state = AsyncData(
        state.requireValue.copyWith(
          settings: settings,
          soulSaving: false,
          soulSaved: true,
        ),
      );
      return true;
    } on PeonSettingsException catch (error) {
      state = AsyncData(
        state.requireValue.copyWith(soulSaving: false, message: error.message),
      );
      return false;
    }
  }

  Future<void> checkForUpdate() async {
    final current = state.value;
    if (current == null) return;
    state = AsyncData(
      current.copyWith(checkingUpdate: true, clearMessage: true),
    );
    try {
      final status = await _repository.checkForUpdate(scope);
      state = AsyncData(
        state.requireValue.copyWith(status: status, checkingUpdate: false),
      );
    } on PeonSettingsException catch (error) {
      state = AsyncData(
        state.requireValue.copyWith(
          checkingUpdate: false,
          message: error.message,
        ),
      );
    }
  }

  Future<void> installUpdate() async {
    final current = state.value;
    if (current == null) return;
    state = AsyncData(
      current.copyWith(
        updatePhase: PeonUpdatePhase.installing,
        clearMessage: true,
      ),
    );
    try {
      await _repository.installUpdate(scope);
      state = AsyncData(
        state.requireValue.copyWith(updatePhase: PeonUpdatePhase.restarting),
      );
      unawaited(_waitForRestart());
    } on PeonSettingsException catch (error) {
      state = AsyncData(
        state.requireValue.copyWith(
          updatePhase: PeonUpdatePhase.idle,
          message: error.message,
        ),
      );
    }
  }

  Future<void> _waitForRestart() async {
    for (var attempt = 0; attempt < _pollingPolicy.maxAttempts; attempt++) {
      await Future.any<void>([
        Future<void>.delayed(_pollingPolicy.interval),
        _disposed.future,
      ]);
      if (_disposed.isCompleted || !ref.mounted) return;
      final status = await _repository.fetchStatus(scope);
      if (_disposed.isCompleted || !ref.mounted) return;
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
    if (_disposed.isCompleted || !ref.mounted) return;
    state = AsyncData(
      state.requireValue.copyWith(
        updatePhase: PeonUpdatePhase.idle,
        message:
            'The Peon did not come back online after the update. '
            'Check its connection and try again.',
      ),
    );
  }

  Future<bool> deletePeon() async {
    final current = state.value;
    if (current == null) return false;
    state = AsyncData(current.copyWith(deleting: true, clearMessage: true));
    try {
      await _repository.deletePeon(scope);
      return true;
    } on PeonSettingsException catch (error) {
      state = AsyncData(
        state.requireValue.copyWith(deleting: false, message: error.message),
      );
      return false;
    }
  }
}
