import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/live/resource_projection.dart';

void main() {
  test(
    'resource projection envelope shares identity, authority and version fencing',
    () {
      final envelope = ResourceProjectionEnvelope.peonOwned(
        workspaceId: 'workspace',
        resourceIdKey: 'sessionId',
        projection: {
          'peonId': 'peon',
          'sessionId': 'session',
          'syncedAt': 4,
          'deleted': true,
        },
      );
      expect(envelope?.authority, ResourceAuthority.peon);
      expect(envelope?.resourceId, 'session');
      expect(envelope?.deleted, isTrue);
      expect(envelope?.isOlderThan(5), isTrue);
      expect(
        ResourceProjectionEnvelope.peonOwned(
          workspaceId: 'workspace',
          resourceIdKey: 'sessionId',
          projection: const {},
        ),
        isNull,
      );
      expect(
        ResourceSnapshot<String>.validated(
          authority: ResourceAuthority.overseer,
          items: const ['workspace'],
          identity: (item) => item,
        ).items,
        const ['workspace'],
      );
      expect(
        () => ResourceSnapshot<String>.validated(
          authority: ResourceAuthority.peon,
          items: const ['duplicate', 'duplicate'],
          identity: (item) => item,
        ),
        throwsFormatException,
      );
    },
  );
}
