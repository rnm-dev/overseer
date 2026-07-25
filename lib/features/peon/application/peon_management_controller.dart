import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/peon_management_models.dart';
import '../domain/peon_management_repository.dart';
import '../domain/peon_settings_models.dart';

final peonManagementRepositoryProvider = Provider<PeonManagementRepository>(
  (ref) => throw StateError(
    'PeonManagementRepository must be supplied by the composition root.',
  ),
);

final armoryControllerProvider = AsyncNotifierProvider.autoDispose
    .family<ArmoryController, ArmoryState, PeonSettingsScope>(
      ArmoryController.new,
      retry: (_, _) => null,
    );

final cliUpdatesControllerProvider = AsyncNotifierProvider.autoDispose
    .family<CliUpdatesController, CliUpdatesState, PeonSettingsScope>(
      CliUpdatesController.new,
      retry: (_, _) => null,
    );

final peonManagementPollingIntervalProvider = Provider(
  (ref) => const Duration(seconds: 1),
);

class ArmoryState {
  const ArmoryState({
    this.inventory,
    this.refreshing = false,
    this.unsupported = false,
    this.busyPackageId,
    this.operation,
    this.message,
  });

  final ArmoryInventory? inventory;
  final bool refreshing;
  final bool unsupported;
  final String? busyPackageId;
  final ArmoryOperation? operation;
  final String? message;

  ArmoryState copyWith({
    ArmoryInventory? inventory,
    bool? refreshing,
    bool? unsupported,
    String? busyPackageId,
    ArmoryOperation? operation,
    String? message,
    bool clearBusy = false,
    bool clearMessage = false,
  }) => ArmoryState(
    inventory: inventory ?? this.inventory,
    refreshing: refreshing ?? this.refreshing,
    unsupported: unsupported ?? this.unsupported,
    busyPackageId: clearBusy ? null : busyPackageId ?? this.busyPackageId,
    operation: clearBusy ? null : operation ?? this.operation,
    message: clearMessage ? null : message ?? this.message,
  );
}

class ArmoryController extends AsyncNotifier<ArmoryState> {
  ArmoryController(this.scope);

  final PeonSettingsScope scope;
  bool _disposed = false;
  PeonManagementRepository get _repository =>
      ref.read(peonManagementRepositoryProvider);

  @override
  Future<ArmoryState> build() async {
    ref.onDispose(() => _disposed = true);
    final cached = await _repository.loadCachedArmory(scope);
    if (!scope.online) {
      return ArmoryState(
        inventory: cached,
        message: cached == null
            ? 'This Peon is offline and has no cached Armory data.'
            : null,
      );
    }
    if (cached != null) {
      Future<void>.microtask(refresh);
      return ArmoryState(inventory: cached, refreshing: true);
    }
    return _load();
  }

  Future<ArmoryState> _load({bool refresh = false}) async {
    try {
      return ArmoryState(
        inventory: await _repository.fetchArmory(scope, refresh: refresh),
      );
    } on PeonManagementException catch (error) {
      return ArmoryState(
        unsupported: error.unsupported,
        message: error.message,
      );
    }
  }

  Future<void> refresh({bool catalog = false}) async {
    final current = state.value ?? const ArmoryState();
    state = AsyncData(current.copyWith(refreshing: true, clearMessage: true));
    try {
      final inventory = await _repository.fetchArmory(scope, refresh: catalog);
      if (!_disposed) {
        state = AsyncData(
          state.requireValue.copyWith(
            inventory: inventory,
            refreshing: false,
            unsupported: false,
          ),
        );
      }
    } on PeonManagementException catch (error) {
      if (!_disposed) {
        state = AsyncData(
          state.requireValue.copyWith(
            refreshing: false,
            unsupported: error.unsupported,
            message: error.message,
          ),
        );
      }
    }
  }

  Future<void> mutate(String packageId, ArmoryAction action) async {
    final current = state.value;
    if (current == null || current.busyPackageId != null || !scope.online) {
      return;
    }
    state = AsyncData(
      current.copyWith(busyPackageId: packageId, clearMessage: true),
    );
    try {
      var operation = await _repository.mutateArmory(scope, packageId, action);
      if (_disposed) return;
      state = AsyncData(state.requireValue.copyWith(operation: operation));
      while (operation.active && !_disposed) {
        await Future<void>.delayed(
          ref.read(peonManagementPollingIntervalProvider),
        );
        if (_disposed) return;
        operation = await _repository.fetchArmoryOperation(scope, operation.id);
        if (!_disposed) {
          state = AsyncData(state.requireValue.copyWith(operation: operation));
        }
      }
      if (!_disposed) {
        final inventory = await _repository.fetchArmory(scope);
        if (!_disposed) {
          state = AsyncData(
            state.requireValue.copyWith(
              inventory: inventory,
              clearBusy: true,
              message: operation.status == 'failure'
                  ? operation.message ?? 'The package operation failed.'
                  : null,
            ),
          );
        }
      }
    } on PeonManagementException catch (error) {
      if (!_disposed) {
        state = AsyncData(
          state.requireValue.copyWith(clearBusy: true, message: error.message),
        );
      }
    }
  }
}

class CliUpdatesState {
  const CliUpdatesState({
    this.items = const [],
    this.hasCache = false,
    this.refreshing = false,
    this.unsupported = false,
    this.starting,
    this.message,
  });

  final List<CliUpdateItem> items;
  final bool hasCache;
  final bool refreshing;
  final bool unsupported;
  final CliProvider? starting;
  final String? message;

  bool get busy => starting != null || items.any((item) => item.busy);

  CliUpdatesState copyWith({
    List<CliUpdateItem>? items,
    bool? hasCache,
    bool? refreshing,
    bool? unsupported,
    CliProvider? starting,
    String? message,
    bool clearStarting = false,
    bool clearMessage = false,
  }) => CliUpdatesState(
    items: items ?? this.items,
    hasCache: hasCache ?? this.hasCache,
    refreshing: refreshing ?? this.refreshing,
    unsupported: unsupported ?? this.unsupported,
    starting: clearStarting ? null : starting ?? this.starting,
    message: clearMessage ? null : message ?? this.message,
  );
}

class CliUpdatesController extends AsyncNotifier<CliUpdatesState> {
  CliUpdatesController(this.scope);

  final PeonSettingsScope scope;
  Timer? _timer;
  PeonManagementRepository get _repository =>
      ref.read(peonManagementRepositoryProvider);

  @override
  Future<CliUpdatesState> build() async {
    ref.onDispose(() => _timer?.cancel());
    final cached = await _repository.loadCachedCliUpdates(scope);
    if (!scope.online) {
      return CliUpdatesState(
        items: cached ?? const [],
        hasCache: cached != null,
        message: cached == null
            ? 'This Peon is offline and has no cached provider update data.'
            : null,
      );
    }
    if (cached != null) {
      Future<void>.microtask(refresh);
      return CliUpdatesState(items: cached, hasCache: true, refreshing: true);
    }
    return _load();
  }

  Future<CliUpdatesState> _load({bool refresh = false}) async {
    try {
      final items = await _repository.fetchCliUpdates(scope, refresh: refresh);
      _schedule(items);
      return CliUpdatesState(items: items, hasCache: true);
    } on PeonManagementException catch (error) {
      return CliUpdatesState(
        unsupported: error.unsupported,
        message: error.message,
      );
    }
  }

  Future<void> refresh({bool force = false}) async {
    final current = state.value ?? const CliUpdatesState();
    state = AsyncData(current.copyWith(refreshing: true, clearMessage: true));
    try {
      final items = await _repository.fetchCliUpdates(scope, refresh: force);
      if (!ref.mounted) return;
      _schedule(items);
      state = AsyncData(
        state.requireValue.copyWith(
          items: items,
          hasCache: true,
          refreshing: false,
          unsupported: false,
        ),
      );
    } on PeonManagementException catch (error) {
      if (!ref.mounted) return;
      state = AsyncData(
        state.requireValue.copyWith(
          refreshing: false,
          unsupported: error.unsupported,
          message: error.message,
        ),
      );
    }
  }

  Future<void> start(CliProvider provider) async {
    final current = state.value;
    if (current == null || current.busy || !scope.online) return;
    state = AsyncData(current.copyWith(starting: provider, clearMessage: true));
    try {
      await _repository.startCliUpdate(scope, provider);
      if (!ref.mounted) return;
      state = AsyncData(state.requireValue.copyWith(clearStarting: true));
      await refresh();
    } on PeonManagementException catch (error) {
      if (!ref.mounted) return;
      state = AsyncData(
        state.requireValue.copyWith(
          clearStarting: true,
          message: error.message,
        ),
      );
    }
  }

  void _schedule(List<CliUpdateItem> items) {
    _timer?.cancel();
    if (!items.any((item) => item.busy)) return;
    _timer = Timer(const Duration(seconds: 2), refresh);
  }
}
