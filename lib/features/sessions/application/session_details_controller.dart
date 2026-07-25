import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/session_models.dart';
import 'sessions_controller.dart';

final sessionDetailsProvider = FutureProvider.autoDispose
    .family<SessionDetails, SessionDetailsScope>((ref, scope) {
      return ref
          .watch(sessionRepositoryProvider)
          .fetchDetails(
            workspaceId: scope.workspaceId,
            peonId: scope.peonId,
            sessionId: scope.sessionId,
          );
    }, retry: (_, _) => null);

class SessionDetailsScope {
  const SessionDetailsScope({
    required this.workspaceId,
    required this.peonId,
    required this.sessionId,
  });

  final String workspaceId;
  final String peonId;
  final String sessionId;

  @override
  bool operator ==(Object other) =>
      other is SessionDetailsScope &&
      other.workspaceId == workspaceId &&
      other.peonId == peonId &&
      other.sessionId == sessionId;

  @override
  int get hashCode => Object.hash(workspaceId, peonId, sessionId);
}
