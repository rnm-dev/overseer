enum ResourceAuthority { peon, overseer }

final class ResourceSnapshot<T> {
  ResourceSnapshot.validated({
    required this.authority,
    required Iterable<T> items,
    required String Function(T item) identity,
    int maxItems = 10000,
  }) : items = List<T>.unmodifiable(items) {
    if (this.items.length > maxItems) {
      throw const FormatException('Resource snapshot exceeds its item limit');
    }
    final identities = <String>{};
    for (final item in this.items) {
      final id = identity(item);
      if (id.isEmpty || !identities.add(id)) {
        throw const FormatException(
          'Resource snapshot has an invalid identity',
        );
      }
    }
  }

  final ResourceAuthority authority;
  final List<T> items;
}

/// Shared typed envelope for catalog-like live projections. Domain repositories
/// remain responsible for parsing payload fields and committing their own rows.
final class ResourceProjectionEnvelope {
  const ResourceProjectionEnvelope({
    required this.authority,
    required this.workspaceId,
    required this.resourceId,
    required this.version,
    required this.deleted,
    this.peonId,
  });

  final ResourceAuthority authority;
  final String workspaceId;
  final String? peonId;
  final String resourceId;
  final double version;
  final bool deleted;

  static ResourceProjectionEnvelope? peonOwned({
    required String workspaceId,
    required String resourceIdKey,
    required Map<String, dynamic> projection,
  }) {
    final peonId = projection['peonId'];
    final resourceId = projection[resourceIdKey];
    if (peonId is! String || resourceId is! String) return null;
    return ResourceProjectionEnvelope(
      authority: ResourceAuthority.peon,
      workspaceId: workspaceId,
      peonId: peonId,
      resourceId: resourceId,
      version: (projection['syncedAt'] as num?)?.toDouble() ?? 0,
      deleted: projection['deleted'] == true,
    );
  }

  bool isOlderThan(double storedVersion) => version < storedVersion;
}
