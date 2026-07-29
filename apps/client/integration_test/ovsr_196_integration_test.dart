import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:overseer_mobile/app/app.dart';
import 'package:overseer_mobile/features/auth/application/auth_controller.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';
import 'package:overseer_mobile/features/auth/domain/auth_repository.dart';
import 'package:overseer_mobile/features/fleet/application/fleet_controller.dart';
import 'package:overseer_mobile/features/fleet/domain/fleet_models.dart';
import 'package:overseer_mobile/features/fleet/domain/fleet_repository.dart';
import 'package:overseer_mobile/features/projects/application/projects_controller.dart';
import 'package:overseer_mobile/features/projects/domain/project_detail_models.dart';
import 'package:overseer_mobile/features/projects/domain/project_models.dart';
import 'package:overseer_mobile/features/projects/domain/project_repository.dart';
import 'package:overseer_mobile/features/sessions/application/session_composer_controller.dart';
import 'package:overseer_mobile/features/sessions/application/sessions_controller.dart';
import 'package:overseer_mobile/features/sessions/domain/followup_repository.dart';
import 'package:overseer_mobile/shared/models/ai_capabilities.dart';
import 'package:overseer_mobile/features/sessions/domain/new_session_repository.dart';
import 'package:overseer_mobile/features/sessions/domain/session_models.dart';
import 'package:overseer_mobile/features/sessions/domain/session_repository.dart';

const _workspaceId = 'workspace-ovsr-196';
const _peonId = 'peon-ovsr-196';
const _sessionId = 'session-ovsr-196';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'restores auth, navigates workspace->peon->session, and submits follow-up',
    (tester) async {
      final authRepository = _HarnessAuthRepository(
        const AuthSession(
          token: 'integration-token',
          user: OperatorIdentity(
            email: 'operator@example.com',
            githubLogin: 'ovsr196',
            avatarUrl: null,
          ),
        ),
      );
      final fleetRepository = _HarnessFleetRepository(
        fleets: const [
          WorkspaceFleet(
            workspace: Workspace(id: _workspaceId, name: 'OVSR 196 Workspace'),
            peons: [
              Peon(
                id: _peonId,
                name: 'OVSR 196 Peon',
                online: true,
                lastSeen: 0,
                capabilities: ['chat'],
              ),
            ],
          ),
        ],
      );
      final sessionRepository = _HarnessSessionRepository(
        sessions: [
          const SessionSummary(
            workspaceId: _workspaceId,
            peonId: _peonId,
            sessionId: _sessionId,
            status: 'running',
            title: 'OVSR 196 Session',
            syncedAt: 0,
          ),
        ],
        details: const SessionDetails(
          turnCount: 1,
          status: 'running',
          projectKey: 'ovsr-196-project',
          projectId: 'ovsr-196-project',
        ),
      );
      final followupRepository = _HarnessFollowupRepository();
      final projectRepository = _HarnessProjectRepository();

      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authRepositoryProvider.overrideWithValue(authRepository),
            fleetRepositoryProvider.overrideWithValue(fleetRepository),
            sessionRepositoryProvider.overrideWithValue(sessionRepository),
            followupRepositoryProvider.overrideWithValue(followupRepository),
            projectRepositoryProvider.overrideWithValue(projectRepository),
          ],
          child: const OverseerMobileApp(),
        ),
      );

      await _waitFor(tester, find.byKey(const Key('compact-shell')));
      expect(find.byKey(const Key('current-overseer-name')), findsOneWidget);
      expect(find.byKey(const Key('overseer-index-navbar')), findsOneWidget);

      final peonRow = find.byKey(const Key('peon-$_peonId'));
      await _waitFor(tester, peonRow);
      await tester.tap(peonRow);
      await tester.pump();
      await _waitFor(tester, find.byKey(const Key('peon-home-page')));
      final sessionRow = find.byKey(const Key('session-$_sessionId'));
      await _waitFor(tester, sessionRow);

      await tester.tap(sessionRow);
      await tester.pump();
      await _waitFor(tester, find.byKey(const Key('session-detail-page')));
      final composerInput = find.byKey(const Key('session-composer-input'));
      await _waitFor(tester, composerInput);
      await _waitUntil(
        tester,
        () => tester.widget<TextField>(composerInput).enabled == true,
      );

      const followupText = 'Run the deterministic integration flow.';
      await tester.enterText(composerInput, followupText);
      await tester.pump();
      final submitButton = find.byKey(const Key('session-composer-submit'));
      await _waitUntil(
        tester,
        () => tester.widget<IconButton>(submitButton).onPressed != null,
      );

      await tester.tap(submitButton);
      await tester.pump(const Duration(milliseconds: 50));

      expect(authRepository.signInCalls, 0);
      expect(followupRepository.submissions, hasLength(1));
      expect(followupRepository.submissions.first.scope.sessionId, _sessionId);
      expect(followupRepository.submissions.first.prompt, followupText);
    },
  );
}

Future<void> _waitFor(
  WidgetTester tester,
  Finder finder, {
  Duration delay = const Duration(milliseconds: 10),
  int attempts = 80,
}) async {
  for (var index = 0; index < attempts; index++) {
    if (finder.evaluate().isNotEmpty) return;
    await tester.pump(delay);
  }
  throw StateError('Timed out waiting for the expected app surface');
}

Future<void> _waitUntil(
  WidgetTester tester,
  bool Function() condition, {
  Duration delay = const Duration(milliseconds: 10),
  int attempts = 80,
}) async {
  for (var index = 0; index < attempts; index++) {
    if (condition()) return;
    await tester.pump(delay);
  }
  throw StateError('Timed out waiting for the expected app state');
}

class _HarnessAuthRepository implements AuthRepository {
  _HarnessAuthRepository(this._session);

  final AuthSession _session;
  int signInCalls = 0;

  @override
  Future<AuthSession?> restore() async => _session;

  @override
  Future<AuthSession> signIn() async {
    signInCalls += 1;
    return _session;
  }

  @override
  Future<void> signOut() async {}
}

class _HarnessFleetRepository implements FleetRepository {
  const _HarnessFleetRepository({required this.fleets});

  final List<WorkspaceFleet> fleets;

  @override
  Future<List<WorkspaceFleet>> loadFleet() async => fleets;
}

class _HarnessProjectRepository implements ProjectRepository {
  @override
  Future<List<PeonProject>> loadCachedProjects({
    required String workspaceId,
    required String peonId,
  }) async => const [];

  @override
  Stream<List<PeonProject>> watchProjects({
    required String workspaceId,
    required String peonId,
  }) => Stream.value(const []);

  @override
  Future<ProjectSnapshot> refreshProjects({
    required String workspaceId,
    required String peonId,
  }) async => const ProjectSnapshot(
    projects: [],
    catalog: ProjectCatalog(state: 'ready', stale: false),
  );

  @override
  Future<ProjectSuggestion> suggestProject({
    required String workspaceId,
    required String peonId,
    required String label,
  }) async => const ProjectSuggestion();

  @override
  Future<void> createProject({
    required String workspaceId,
    required String peonId,
    required String label,
    String? dir,
    String? metadata,
  }) async {}

  @override
  Future<ProjectDirectory> fetchDirectory({
    required String workspaceId,
    required String peonId,
    required String projectKey,
    required String path,
  }) async => const ProjectDirectory(path: '', entries: []);

  @override
  Future<ProjectFilePreview> fetchFile({
    required String workspaceId,
    required String peonId,
    required String projectKey,
    required String path,
  }) async => ProjectFilePreview(
    path: '',
    bytes: Uint8List(0),
    contentType: 'text/plain',
  );

  @override
  Future<void> applyLiveProjection({
    required String workspaceId,
    required int cursor,
    required Map<String, dynamic> projection,
  }) async {}

  @override
  Future<void> advanceCursor({
    required String workspaceId,
    required int cursor,
  }) async {}

  @override
  Future<int> cursorFor(String workspaceId) async => 0;
}

class _HarnessSessionRepository implements SessionRepository {
  _HarnessSessionRepository({required this.sessions, required this.details});

  final List<SessionSummary> sessions;
  final SessionDetails details;

  @override
  Future<List<SessionSummary>> loadCachedSessions({
    required String workspaceId,
    required String peonId,
  }) async => sessions;

  @override
  Stream<List<SessionSummary>> watchSessions({
    required String workspaceId,
    required String peonId,
  }) => Stream.value(sessions);

  @override
  Future<SessionPage> fetchPage({
    required String workspaceId,
    required String peonId,
    required int offset,
    int limit = 50,
  }) async {
    final safeOffset = offset.clamp(0, sessions.length);
    final upper = (safeOffset + limit).clamp(0, sessions.length);
    final values = sessions.sublist(safeOffset, upper);
    return SessionPage(
      sessions: values,
      total: sessions.length,
      offset: safeOffset,
      limit: limit,
      catalogStale: false,
    );
  }

  @override
  Future<SessionDetails> fetchDetails({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) async => details;

  @override
  Future<void> markSessionAttentionRead({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) async {}

  @override
  Future<void> cancelSession({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) async {}

  @override
  Future<void> renameSession({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String? title,
  }) async {}

  @override
  Future<void> deleteSession({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) async {}

  @override
  Future<TranscriptCache> loadCachedTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) async => const TranscriptCache(events: [], hasOlder: false);

  @override
  Stream<List<TranscriptEvent>> watchTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) => Stream.value(const []);

  @override
  Future<TranscriptPage> fetchLatestTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    int limit = 50,
  }) async => const TranscriptPage(
    events: [],
    nextCursor: null,
    hasMore: false,
    insertedCount: 0,
  );

  @override
  Future<TranscriptPage> fetchOlderTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String cursor,
    int limit = 50,
  }) async => const TranscriptPage(
    events: [],
    nextCursor: null,
    hasMore: false,
    insertedCount: 0,
  );

  @override
  Future<void> cacheTailEvent({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String eventId,
    required Map<String, dynamic> payload,
  }) async {}

  @override
  Future<int> cursorFor(String workspaceId) async => 0;

  @override
  Future<void> advanceCursor({
    required String workspaceId,
    required int cursor,
  }) async {}

  @override
  Future<void> applyLiveProjection({
    required String workspaceId,
    required int cursor,
    required Map<String, dynamic> projection,
  }) async {}
}

class _HarnessFollowupRepository implements FollowupRepository {
  final List<_SubmissionRecord> submissions = [];

  @override
  Future<String> loadDraft(FollowupScope scope) async => '';

  @override
  Future<void> saveDraft(FollowupScope scope, String text) async {}

  @override
  Stream<List<PendingFollowup>> watchPending(FollowupScope scope) =>
      Stream.value(const []);

  @override
  Stream<List<QueuedFollowup>> watchQueue(FollowupScope scope) =>
      Stream.value(const []);

  @override
  Future<void> refreshQueue(FollowupScope scope) async {}

  @override
  Future<void> editQueued(
    FollowupScope scope,
    String itemId,
    String prompt,
  ) async {}

  @override
  Future<void> removeQueued(FollowupScope scope, String itemId) async {}

  @override
  Future<void> sendQueuedNow(FollowupScope scope, String itemId) async {}

  @override
  Future<ModelsCatalog?> fetchModelCatalog(FollowupScope scope) async => null;

  @override
  Future<FollowupDelivery> submit({
    required FollowupScope scope,
    required String prompt,
    required bool serverQueue,
    bool startNow = false,
    String? agent,
    String? model,
    String? reasoningEffort,
    String? commandId,
    List<NewSessionAttachment> attachments = const [],
    FollowupProgressCallback? onProgress,
  }) async {
    submissions.add(
      _SubmissionRecord(
        scope: scope,
        prompt: prompt,
        serverQueue: serverQueue,
        startNow: startNow,
        commandId: commandId,
      ),
    );
    return FollowupDelivery.delivered;
  }

  @override
  Future<bool> retryPending(FollowupScope scope) async => false;
}

class _SubmissionRecord {
  const _SubmissionRecord({
    required this.scope,
    required this.prompt,
    required this.serverQueue,
    required this.startNow,
    this.commandId,
  });

  final FollowupScope scope;
  final String prompt;
  final bool serverQueue;
  final bool startNow;
  final String? commandId;
}
