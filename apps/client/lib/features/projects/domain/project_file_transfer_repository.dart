/// Moves bytes and entries inside a project tree.
abstract interface class ProjectFileTransferRepository {
  /// Streams one file to [path], relative to the project root.
  Future<void> upload({
    required String workspaceId,
    required String peonId,
    required String projectKey,
    required String path,
    required Stream<List<int>> bytes,
    required int length,
    void Function(int sent, int total)? onProgress,
  });

  /// Moves [source] to [destination]; both are full project-relative paths.
  Future<void> move({
    required String workspaceId,
    required String peonId,
    required String projectKey,
    required String source,
    required String destination,
  });
}
