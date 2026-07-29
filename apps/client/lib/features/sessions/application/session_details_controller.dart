import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/session_models.dart';
import '../domain/session_repository.dart';
import 'sessions_controller.dart';

final sessionDetailsProvider = FutureProvider.autoDispose
    .family<SessionDetails, SessionDetailsScope>((ref, scope) {
      final repository = ref.watch(sessionRepositoryProvider);
      unawaited(_markAttentionRead(repository, scope));
      return repository.fetchDetails(
        workspaceId: scope.workspaceId,
        peonId: scope.peonId,
        sessionId: scope.sessionId,
      );
    }, retry: (_, _) => null);

Future<void> _markAttentionRead(
  SessionRepository repository,
  SessionDetailsScope scope,
) async {
  try {
    await repository.markSessionAttentionRead(
      workspaceId: scope.workspaceId,
      peonId: scope.peonId,
      sessionId: scope.sessionId,
    );
  } on SessionsException {
    // Reading the cached transcript remains useful offline. The next
    // foreground refresh retries this idempotent acknowledgement.
  }
}

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
