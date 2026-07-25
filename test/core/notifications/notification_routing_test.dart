import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/config/overseer_connection_store.dart';
import 'package:overseer_mobile/core/notifications/notification_routing.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  group('NotificationDestination', () {
    test('parses session notification data into an encoded app location', () {
      final destination = NotificationDestination.fromData({
        'kind': 'session',
        'workspaceId': 'workspace one',
        'peonId': 'peon/1',
        'sessionId': 'session?1',
      });

      expect(
        destination,
        const NotificationDestination.session(
          workspaceId: 'workspace one',
          peonId: 'peon/1',
          sessionId: 'session?1',
        ),
      );
      expect(Uri.parse(destination!.location).queryParameters, {
        'workspaceId': 'workspace one',
        'peonId': 'peon/1',
        'sessionId': 'session?1',
      });
    });

    test('routes peon payloads without requiring a session identifier', () {
      expect(
        NotificationDestination.fromData({
          'kind': 'peon',
          'workspaceId': 'workspace',
          'peonId': 'peon',
        }),
        const NotificationDestination.peon(
          workspaceId: 'workspace',
          peonId: 'peon',
        ),
      );
    });

    test('accepts only app-owned peon and session deep links', () {
      expect(
        NotificationDestination.fromUri(
          Uri.parse(
            'overseer-dev://open/session'
            '?workspaceId=workspace&peonId=peon&sessionId=session',
          ),
        ),
        const NotificationDestination.session(
          workspaceId: 'workspace',
          peonId: 'peon',
          sessionId: 'session',
        ),
      );
      expect(
        NotificationDestination.fromUri(
          Uri.parse('overseer://open/peon?workspaceId=workspace&peonId=peon'),
        ),
        const NotificationDestination.peon(
          workspaceId: 'workspace',
          peonId: 'peon',
        ),
      );
      expect(
        NotificationDestination.fromUri(
          Uri.parse(
            'https://malicious.example/session'
            '?workspaceId=workspace&peonId=peon&sessionId=session',
          ),
        ),
        isNull,
      );
    });

    test('rejects incomplete or unreasonably large routing fields', () {
      expect(
        NotificationDestination.fromData({
          'kind': 'session',
          'workspaceId': 'workspace',
          'peonId': 'peon',
        }),
        isNull,
      );
      expect(
        NotificationDestination.fromData({
          'kind': 'peon',
          'workspaceId': 'w' * 513,
          'peonId': 'peon',
        }),
        isNull,
      );
    });
  });

  test('keeps workspace routes isolated between saved connections', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final store = SharedPreferencesNotificationRouteStore();
    final first = OverseerConnection(
      serverUrl: Uri.parse('https://one.example'),
    );
    final second = OverseerConnection(
      serverUrl: Uri.parse('https://two.example'),
    );

    await store.recordConnection(
      connection: first,
      workspaceIds: const ['workspace-one'],
    );
    await store.recordConnection(
      connection: second,
      workspaceIds: const ['workspace-two'],
    );

    expect(
      await store.connectionForWorkspace('workspace-one'),
      first.serverUrl,
    );
    expect(
      await store.connectionForWorkspace('workspace-two'),
      second.serverUrl,
    );
    expect(await store.connectionForWorkspace('unknown'), isNull);
  });
}
