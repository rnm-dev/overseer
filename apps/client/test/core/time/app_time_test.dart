import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/time/app_time.dart';

void main() {
  test(
    'system scheduler supports one-shot and periodic cancellation',
    () async {
      const scheduler = SystemAppScheduler();
      final oneShot = Completer<void>();
      var periodicCalls = 0;
      final periodic = scheduler.periodic(
        const Duration(milliseconds: 1),
        () => periodicCalls += 1,
      );
      scheduler.schedule(const Duration(milliseconds: 1), oneShot.complete);

      await oneShot.future.timeout(const Duration(seconds: 1));
      await scheduler.delay(const Duration(milliseconds: 5));
      periodic.cancel();
      final callsAtCancellation = periodicCalls;
      await scheduler.delay(const Duration(milliseconds: 5));

      expect(callsAtCancellation, greaterThan(0));
      expect(periodicCalls, callsAtCancellation);
      expect(periodic.isActive, isFalse);
    },
  );
}
