import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/live/transcript_live_service.dart';
import 'package:overseer_mobile/features/sessions/application/session_queue_change.dart';
import 'package:overseer_mobile/features/sessions/application/sessions_controller.dart';
import 'package:overseer_mobile/features/sessions/application/transcript_controller.dart';
import 'package:overseer_mobile/features/sessions/domain/followup_repository.dart';
import 'package:overseer_mobile/features/sessions/domain/session_models.dart';
import 'package:overseer_mobile/features/sessions/domain/session_repository.dart';

void main() {
  const scope = TranscriptScope(
    workspaceId: 'workspace',
    peonId: 'peon',
    sessionId: 'session',
    isRunning: true,
  );
  const followupScope = FollowupScope(
    workspaceId: 'workspace',
    peonId: 'peon',
    sessionId: 'session',
  );

  test('keeps running fenced across consecutive queued turns', () async {
    final live = _FakeTranscriptLiveService();
    final container = ProviderContainer(
      overrides: [
        sessionRepositoryProvider.overrideWithValue(_FakeSessionRepository()),
        transcriptLiveServiceProvider.overrideWithValue(live),
      ],
    );
    addTearDown(container.dispose);
    final subscription = container.listen(
      transcriptControllerProvider(scope),
      (_, _) {},
      fireImmediately: true,
    );
    addTearDown(subscription.close);

    final initial = await container.read(
      transcriptControllerProvider(scope).future,
    );
    expect(initial.isRunning, isTrue);
    while (live.onFrame == null) {
      await Future<void>.delayed(Duration.zero);
    }

    container
        .read(sessionQueueChangeProvider(followupScope).notifier)
        .replacePending(true);
    await live.onFrame!(
      const TranscriptTailFrame.event(
        eventId: 'result-1',
        data: '{"type":"result"}',
      ),
    );
    expect(
      container
          .read(transcriptControllerProvider(scope))
          .requireValue
          .isRunning,
      isTrue,
    );

    container
        .read(sessionQueueChangeProvider(followupScope).notifier)
        .replacePending(false);
    await live.onFrame!(
      const TranscriptTailFrame.event(
        eventId: 'result-2',
        data: '{"type":"result"}',
      ),
    );
    expect(
      container
          .read(transcriptControllerProvider(scope))
          .requireValue
          .isRunning,
      isFalse,
    );
  });
}

class _FakeTranscriptLiveService implements TranscriptLiveService {
  Future<void> Function(TranscriptTailFrame frame)? onFrame;

  @override
  void subscribeTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String? lastEventId,
    required Future<void> Function(TranscriptTailFrame frame) onFrame,
  }) {
    this.onFrame = onFrame;
  }

  @override
  void unsubscribeTranscript({
    required String workspaceId,
    required String sessionId,
  }) {}
}

class _FakeSessionRepository implements SessionRepository {
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
  Future<SessionDetails> fetchDetails({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) async => const SessionDetails(turnCount: 1, status: 'completed');

  @override
  Future<void> cacheTailEvent({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String eventId,
    required Map<String, dynamic> payload,
  }) async {}

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
