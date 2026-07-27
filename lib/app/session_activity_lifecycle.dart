import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/database/app_database.dart';
import '../core/diagnostics/app_diagnostics.dart';
import '../core/live/active_sessions.dart';
import '../core/live_activities/session_activity.dart';
import '../features/auth/application/auth_controller.dart';

final sessionActivityConnectionIdProvider = Provider<String>(
  (ref) =>
      throw StateError('Session activity connection ID is not configured.'),
);

final completedUnreadSessionCountProvider = StreamProvider.autoDispose<int>((
  ref,
) {
  final database = ref.watch(appDatabaseProvider);
  final query = database.select(database.cachedSessions)
    ..where((row) => row.attentionUnread.equals(true));
  return query.watch().map((rows) => rows.length);
});

class SessionActivityLifecycle extends ConsumerWidget {
  const SessionActivityLifecycle({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final authSession = ref.watch(authControllerProvider).session;
    final operatorIdentities = <String>{};
    if (authSession case final session?) {
      operatorIdentities.add(session.user.email);
      if (session.user.githubLogin case final login?) {
        operatorIdentities.add(login);
      }
    }
    final activeSessions = ref.watch(activeSessionsProvider);
    final hasRunningSessions =
        authSession != null &&
        activeSessions.authoritativeByWorkspace.values.any(
          (workspace) => workspace.sessions.isNotEmpty,
        );
    final completedUnreadCount = hasRunningSessions
        ? ref.watch(completedUnreadSessionCountProvider).value ?? 0
        : 0;
    final connectionId = ref.watch(sessionActivityConnectionIdProvider);
    final coordinator = ref.watch(sessionActivityCoordinatorProvider);
    final registration = ref.watch(sessionActivityRegistrationProvider);
    final diagnostics = ref.watch(appDiagnosticsProvider);
    Future<void>.microtask(() {
      unawaited(
        registration.setAuthToken(authSession?.token).catchError((error) {
          diagnostics.record(
            AppDiagnosticEvent(
              name: 'activity.registration',
              level: AppDiagnosticLevel.warning,
              connectionId: connectionId,
              state: 'auth',
              outcome: 'failed',
              errorType: error.runtimeType.toString(),
            ),
          );
        }),
      );
      unawaited(
        coordinator
            .reconcile(
              connectionId: connectionId,
              operatorIdentities: operatorIdentities,
              activeSessions: activeSessions,
              completedUnreadCount: completedUnreadCount,
            )
            .catchError((error) {
              diagnostics.record(
                AppDiagnosticEvent(
                  name: 'activity.synchronize',
                  level: AppDiagnosticLevel.warning,
                  connectionId: connectionId,
                  state: 'failed',
                  errorType: error.runtimeType.toString(),
                ),
              );
            }),
      );
    });
    return child;
  }
}
