import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/followup_repository.dart';
import '../domain/session_models.dart';
import '../domain/session_repository.dart';
import 'sessions_controller.dart';

final sessionDetailsSnapshotProvider = NotifierProvider.autoDispose
    .family<SessionDetailsSnapshot, SessionDetails?, SessionDetailsScope>(
      SessionDetailsSnapshot.new,
    );

class SessionDetailsSnapshot extends Notifier<SessionDetails?> {
  SessionDetailsSnapshot(this.scope);

  final SessionDetailsScope scope;

  @override
  SessionDetails? build() => null;

  int get generation => _generation;
  var _generation = 0;

  void publish(SessionDetails details) {
    _generation++;
    state = details;
  }

  void publishIfCurrent(int requestGeneration, SessionDetails details) {
    if (_generation == requestGeneration) publish(details);
  }
}

final sessionDetailsProvider = FutureProvider.autoDispose
    .family<SessionDetails, SessionDetailsScope>((ref, scope) {
      final repository = ref.watch(sessionRepositoryProvider);
      unawaited(_markAttentionRead(repository, scope));
      final snapshot = ref.watch(
        sessionDetailsSnapshotProvider(scope).notifier,
      );
      final generation = snapshot.generation;
      return repository
          .fetchDetails(
            workspaceId: scope.workspaceId,
            peonId: scope.peonId,
            sessionId: scope.sessionId,
          )
          .then((details) {
            if (ref.mounted) snapshot.publishIfCurrent(generation, details);
            return details;
          });
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

void publishSessionDetails(
  Ref ref,
  SessionDetailsScope scope,
  SessionDetails details,
) {
  ref.read(sessionDetailsSnapshotProvider(scope).notifier).publish(details);
}

/// Session details are keyed by the same (workspace, peon, session) triple as
/// follow-ups.
typedef SessionDetailsScope = FollowupScope;
