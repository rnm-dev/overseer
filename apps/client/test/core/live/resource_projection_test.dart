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
      expect(envelope?.hasVersion, isTrue);
      expect(envelope?.isOlderThan(5), isTrue);
      final legacy = ResourceProjectionEnvelope.peonOwned(
        workspaceId: 'workspace',
        resourceIdKey: 'peonId',
        projection: const {'peonId': 'peon'},
      );
      expect(legacy?.hasVersion, isFalse);
      expect(legacy?.isOlderThan(1), isFalse);
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
      expect(
        () => ResourceSnapshot<int>.validated(
          authority: ResourceAuthority.peon,
          items: List<int>.generate(10001, (index) => index),
          identity: (item) => '$item',
        ),
        throwsFormatException,
      );
    },
  );
}
