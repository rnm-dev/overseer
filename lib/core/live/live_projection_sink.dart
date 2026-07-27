abstract interface class LiveProjectionSink {
  Future<void> applyLiveProjection({
    required String workspaceId,
    required int cursor,
    required Map<String, dynamic> projection,
  });

  Future<void> advanceCursor({
    required String workspaceId,
    required int cursor,
  });

  Future<int> cursorFor(String workspaceId);
}

abstract interface class AttentionProjectionSink {
  Future<void> applyAttentionProjection({
    required String workspaceId,
    required int cursor,
    required Map<String, dynamic> projection,
  });
}
