import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:overseer_mobile/core/notifications/push_notification_service.dart';
import 'package:overseer_mobile/features/auth/application/auth_controller.dart';

class PushNotificationLifecycle extends ConsumerStatefulWidget {
  const PushNotificationLifecycle({super.key, required this.child});

  final Widget child;

  @override
  ConsumerState<PushNotificationLifecycle> createState() =>
      _PushNotificationLifecycleState();
}

class _PushNotificationLifecycleState
    extends ConsumerState<PushNotificationLifecycle> {
  @override
  void initState() {
    super.initState();
    ref.listenManual(
      authControllerProvider,
      (_, state) => unawaited(
        ref
            .read(pushNotificationServiceProvider)
            .setAuthToken(state.session?.token),
      ),
      fireImmediately: true,
    );
  }

  @override
  Widget build(BuildContext context) {
    return widget.child;
  }
}
