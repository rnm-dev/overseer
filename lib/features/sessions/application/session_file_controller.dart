import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/session_file_repository.dart';

final sessionFileRepositoryProvider = Provider<SessionFileRepository>(
  (ref) => throw StateError(
    'SessionFileRepository must be supplied by the application composition root.',
  ),
);

enum SessionFileSource { artifact, attachment }

class SessionFileScope {
  const SessionFileScope.artifact({
    required this.workspaceId,
    required this.peonId,
    required this.sessionId,
    required this.path,
  }) : source = SessionFileSource.artifact,
       name = null,
       type = null;

  const SessionFileScope.attachment({
    required this.workspaceId,
    required this.peonId,
    required this.sessionId,
    required this.path,
    required this.name,
    this.type,
  }) : source = SessionFileSource.attachment;

  final String workspaceId;
  final String peonId;
  final String sessionId;
  final String path;
  final String? name;
  final String? type;
  final SessionFileSource source;

  String get displayPath => name ?? path;

  @override
  bool operator ==(Object other) =>
      other is SessionFileScope &&
      other.workspaceId == workspaceId &&
      other.peonId == peonId &&
      other.sessionId == sessionId &&
      other.path == path &&
      other.name == name &&
      other.type == type &&
      other.source == source;

  @override
  int get hashCode =>
      Object.hash(workspaceId, peonId, sessionId, path, name, type, source);
}

final sessionFileControllerProvider = FutureProvider.autoDispose
    .family<SessionFilePreview, SessionFileScope>((ref, scope) {
      final repository = ref.watch(sessionFileRepositoryProvider);
      return switch (scope.source) {
        SessionFileSource.artifact => repository.fetchArtifact(
          workspaceId: scope.workspaceId,
          peonId: scope.peonId,
          sessionId: scope.sessionId,
          path: scope.path,
        ),
        SessionFileSource.attachment => repository.fetchAttachment(
          workspaceId: scope.workspaceId,
          peonId: scope.peonId,
          path: scope.path,
          name: scope.name ?? scope.path,
          type: scope.type,
        ),
      };
    });
