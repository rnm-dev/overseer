import 'dart:async';

import 'package:overseer_mobile/core/time/app_time.dart';

class MutableAppClock implements AppClock {
  MutableAppClock(this.value);

  DateTime value;

  @override
  DateTime now() => value;
}

class ManualAppScheduler implements AppScheduler {
  ManualAppScheduler({this.clock});

  final MutableAppClock? clock;
  Duration _elapsed = Duration.zero;
  int _sequence = 0;
  final List<_ManualTask> _tasks = [];

  int get pendingTaskCount => _tasks.where((task) => task.isActive).length;
  List<Duration> get pendingDelays => [
    for (final task in _tasks)
      if (task.isActive) task.due - _elapsed,
  ];

  @override
  Future<void> delay(Duration duration) {
    final completer = Completer<void>();
    schedule(duration, completer.complete);
    return completer.future;
  }

  @override
  ScheduledTask periodic(Duration interval, void Function() callback) {
    if (interval <= Duration.zero) {
      throw ArgumentError.value(interval, 'interval', 'must be positive');
    }
    return _add(interval, callback, interval: interval);
  }

  @override
  ScheduledTask schedule(Duration delay, void Function() callback) =>
      _add(delay, callback);

  Future<void> advance(Duration duration) async {
    final target = _elapsed + duration;
    while (true) {
      final due =
          _tasks.where((task) => task.isActive && task.due <= target).toList()
            ..sort((left, right) {
              final dueOrder = left.due.compareTo(right.due);
              return dueOrder != 0 ? dueOrder : left.sequence - right.sequence;
            });
      if (due.isEmpty) break;
      final task = due.first;
      _setElapsed(task.due);
      if (task.interval == null) {
        task.active = false;
      } else {
        task.due += task.interval!;
      }
      task.callback();
      await _flushAsyncWork();
    }
    _setElapsed(target);
    await _flushAsyncWork();
    _tasks.removeWhere((task) => !task.isActive);
  }

  ScheduledTask _add(
    Duration delay,
    void Function() callback, {
    Duration? interval,
  }) {
    final task = _ManualTask(
      due: _elapsed + delay,
      sequence: _sequence++,
      callback: callback,
      interval: interval,
    );
    _tasks.add(task);
    return task;
  }

  void _setElapsed(Duration value) {
    final delta = value - _elapsed;
    _elapsed = value;
    final mutableClock = clock;
    if (mutableClock != null) {
      mutableClock.value = mutableClock.value.add(delta);
    }
  }

  Future<void> _flushAsyncWork() async {
    for (var index = 0; index < 5; index++) {
      await Future<void>.delayed(Duration.zero);
    }
  }
}

class _ManualTask implements ScheduledTask {
  _ManualTask({
    required this.due,
    required this.sequence,
    required this.callback,
    this.interval,
  });

  Duration due;
  final int sequence;
  final void Function() callback;
  final Duration? interval;
  bool active = true;

  @override
  bool get isActive => active;

  @override
  void cancel() => active = false;
}
