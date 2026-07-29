import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/live/presence.dart';

void main() {
  test('peon and session viewers match web scoping and deduplication', () {
    const state = PresenceState(
      entriesByWorkspace: {
        'workspace': [
          PresenceEntry(
            userId: 'workspace-viewer',
            email: 'workspace@example.test',
            scope: PresenceScope.workspace,
          ),
          PresenceEntry(
            userId: 'peon-viewer',
            email: 'peon@example.test',
            githubLogin: 'Beta',
            scope: PresenceScope.peon,
            peonId: 'peon',
          ),
          PresenceEntry(
            userId: 'session-viewer',
            email: 'alpha@example.test',
            githubLogin: 'Alpha',
            scope: PresenceScope.session,
            peonId: 'peon',
            sessionId: 'session',
          ),
          PresenceEntry(
            userId: 'session-viewer-duplicate',
            email: 'ALPHA@example.test',
            scope: PresenceScope.session,
            peonId: 'peon',
            sessionId: 'session',
          ),
        ],
      },
    );

    expect(
      state
          .viewersForPeon(workspaceId: 'workspace', peonId: 'peon')
          .map((viewer) => viewer.displayName),
      ['Alpha', 'Beta'],
    );
    expect(
      state
          .viewersForSession(
            workspaceId: 'workspace',
            peonId: 'peon',
            sessionId: 'session',
          )
          .map((viewer) => viewer.displayName),
      ['Alpha'],
    );
  });

  test('presence locations serialize to the socket contract', () {
    expect(const PresenceLocation.workspace().toJson(), {
      'type': 'presence:set',
      'scope': 'workspace',
    });
    expect(const PresenceLocation.peon(peonId: 'peon').toJson(), {
      'type': 'presence:set',
      'scope': 'peon',
      'peonId': 'peon',
    });
    expect(
      const PresenceLocation.session(
        peonId: 'peon',
        sessionId: 'session',
      ).toJson(),
      {
        'type': 'presence:set',
        'scope': 'session',
        'peonId': 'peon',
        'sessionId': 'session',
      },
    );
  });
}
