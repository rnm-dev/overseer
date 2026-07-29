import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

final appClockProvider = Provider<AppClock>((ref) => const SystemAppClock());

final appSchedulerProvider = Provider<AppScheduler>(
  (ref) => const SystemAppScheduler(),
);

abstract interface class AppClock {
  DateTime now();
}

class SystemAppClock implements AppClock {
  const SystemAppClock();

  @override
  DateTime now() => DateTime.now();
}

abstract interface class ScheduledTask {
  bool get isActive;

  void cancel();
}

abstract interface class AppScheduler {
  ScheduledTask schedule(Duration delay, void Function() callback);

  ScheduledTask periodic(Duration interval, void Function() callback);

  Future<void> delay(Duration duration);
}

class SystemAppScheduler implements AppScheduler {
  const SystemAppScheduler();

  @override
  Future<void> delay(Duration duration) => Future<void>.delayed(duration);

  @override
  ScheduledTask periodic(Duration interval, void Function() callback) =>
      _TimerScheduledTask(Timer.periodic(interval, (_) => callback()));

  @override
  ScheduledTask schedule(Duration delay, void Function() callback) =>
      _TimerScheduledTask(Timer(delay, callback));
}

class _TimerScheduledTask implements ScheduledTask {
  const _TimerScheduledTask(this._timer);

  final Timer _timer;

  @override
  bool get isActive => _timer.isActive;

  @override
  void cancel() => _timer.cancel();
}
