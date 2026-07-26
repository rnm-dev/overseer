import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/live/active_sessions.dart';
import '../core/live_activities/session_activity.dart';
import '../features/auth/application/auth_controller.dart';

class SessionActivityLifecycle extends ConsumerWidget {
  const SessionActivityLifecycle({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final authSession = ref.watch(authControllerProvider).session;
    final activeSessions = ref.watch(activeSessionsProvider);
    final coordinator = ref.watch(sessionActivityCoordinatorProvider);
    final registration = ref.watch(sessionActivityRegistrationProvider);
    Future<void>.microtask(() {
      unawaited(
        registration.setAuthToken(authSession?.token).catchError((_) {}),
      );
      unawaited(
        coordinator
            .reconcile(authSession: authSession, activeSessions: activeSessions)
            .catchError((_) {}),
      );
    });
    return child;
  }
}
