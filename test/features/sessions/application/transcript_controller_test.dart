import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/live/transcript_live_service.dart';
import 'package:overseer_mobile/features/sessions/application/session_queue_change.dart';
import 'package:overseer_mobile/features/sessions/application/sessions_controller.dart';
import 'package:overseer_mobile/features/sessions/application/transcript_controller.dart';
import 'package:overseer_mobile/features/sessions/domain/followup_repository.dart';
import 'package:overseer_mobile/features/sessions/domain/session_models.dart';
import 'package:overseer_mobile/features/sessions/domain/session_repository.dart';
import 'package:overseer_mobile/features/settings/application/sound_pack_controller.dart';
import 'package:overseer_mobile/features/settings/domain/sound_pack.dart';
import 'package:overseer_mobile/features/settings/domain/work_sound_player.dart';

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

  test(
    'subscribes from cached boundary before latest transcript refresh completes',
    () async {
      final latest = Completer<TranscriptPage>();
      final repository = _FakeSessionRepository(
        cached: TranscriptCache(
          events: [
            TranscriptEvent(
              eventId: 'cached-7',
              orderKey: 7,
              payload: {'type': 'assistant'},
            ),
          ],
          hasOlder: true,
        ),
        latest: latest.future,
      );
      final live = _FakeTranscriptLiveService();
      final container = ProviderContainer(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(repository),
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

      await container.read(transcriptControllerProvider(scope).future);
      while (live.subscriptions.isEmpty) {
        await Future<void>.delayed(Duration.zero);
      }

      expect(live.subscriptions, ['cached-7']);
      expect(repository.latestCompleted, isFalse);

      latest.complete(
        TranscriptPage(
          events: [
            TranscriptEvent(
              eventId: 'latest-9',
              orderKey: 9,
              payload: {'type': 'assistant'},
            ),
          ],
          nextCursor: 'older',
          hasMore: true,
          insertedCount: 1,
        ),
      );
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(live.subscriptions, ['cached-7']);
    },
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

  test(
    'foreground resume immediately refreshes the newest transcript page',
    () async {
      final repository = _FakeSessionRepository();
      final container = ProviderContainer(
        overrides: [sessionRepositoryProvider.overrideWithValue(repository)],
      );
      addTearDown(container.dispose);
      final subscription = container.listen(
        transcriptControllerProvider(scope),
        (_, _) {},
        fireImmediately: true,
      );
      addTearDown(subscription.close);

      await container.read(transcriptControllerProvider(scope).future);
      while (repository.latestRequests < 1 ||
          container
              .read(transcriptControllerProvider(scope))
              .requireValue
              .isRefreshing) {
        await Future<void>.delayed(Duration.zero);
      }

      await container
          .read(transcriptControllerProvider(scope).notifier)
          .resumeFromBackground();

      expect(repository.latestRequests, 2);
    },
  );

  test('plays completion only for the final successful queued turn', () async {
    final live = _FakeTranscriptLiveService();
    final sounds = _RecordingWorkSoundPlayer();
    final container = ProviderContainer(
      overrides: [
        sessionRepositoryProvider.overrideWithValue(_FakeSessionRepository()),
        transcriptLiveServiceProvider.overrideWithValue(live),
        workSoundPlayerProvider.overrideWithValue(sounds),
      ],
    );
    addTearDown(container.dispose);
    final subscription = container.listen(
      transcriptControllerProvider(scope),
      (_, _) {},
      fireImmediately: true,
    );
    addTearDown(subscription.close);

    await container.read(transcriptControllerProvider(scope).future);
    while (live.onFrame == null) {
      await Future<void>.delayed(Duration.zero);
    }

    container
        .read(sessionQueueChangeProvider(followupScope).notifier)
        .replacePending(true);
    await live.onFrame!(
      const TranscriptTailFrame.event(
        eventId: 'result-queued',
        data: '{"type":"result"}',
      ),
    );
    expect(sounds.cues, isEmpty);

    container
        .read(sessionQueueChangeProvider(followupScope).notifier)
        .replacePending(false);
    await live.onFrame!(
      const TranscriptTailFrame.event(
        eventId: 'result-final',
        data: '{"type":"result","is_error":false}',
      ),
    );
    expect(sounds.cues, [(SoundPack.peon, WorkSoundCue.complete)]);

    await live.onFrame!(
      const TranscriptTailFrame.event(
        eventId: 'result-error',
        data: '{"type":"result","is_error":true}',
      ),
    );
    expect(sounds.cues, [(SoundPack.peon, WorkSoundCue.complete)]);
  });

  test('manual stop suppresses its completion result sound', () async {
    final live = _FakeTranscriptLiveService();
    final sounds = _RecordingWorkSoundPlayer();
    final container = ProviderContainer(
      overrides: [
        sessionRepositoryProvider.overrideWithValue(_FakeSessionRepository()),
        transcriptLiveServiceProvider.overrideWithValue(live),
        workSoundPlayerProvider.overrideWithValue(sounds),
      ],
    );
    addTearDown(container.dispose);
    final subscription = container.listen(
      transcriptControllerProvider(scope),
      (_, _) {},
      fireImmediately: true,
    );
    addTearDown(subscription.close);

    await container.read(transcriptControllerProvider(scope).future);
    while (live.onFrame == null) {
      await Future<void>.delayed(Duration.zero);
    }

    container
        .read(transcriptControllerProvider(scope).notifier)
        .suppressNextCompletionSound();
    await live.onFrame!(
      const TranscriptTailFrame.event(
        eventId: 'cancel-result',
        data: '{"type":"result","is_error":false}',
      ),
    );

    expect(sounds.cues, isEmpty);
  });
}

class _RecordingWorkSoundPlayer implements WorkSoundPlayer {
  final cues = <(SoundPack, WorkSoundCue)>[];

  @override
  Future<void> play(SoundPack pack) async {}

  @override
  Future<void> playCue(SoundPack pack, WorkSoundCue cue) async {
    cues.add((pack, cue));
  }

  @override
  Future<void> stop() async {}

  @override
  Future<void> dispose() async {}
}

class _FakeTranscriptLiveService implements TranscriptLiveService {
  Future<void> Function(TranscriptTailFrame frame)? onFrame;
  final List<String?> subscriptions = [];

  @override
  void subscribeTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String? lastEventId,
    required Future<void> Function(TranscriptTailFrame frame) onFrame,
  }) {
    this.onFrame = onFrame;
    subscriptions.add(lastEventId);
  }

  @override
  void unsubscribeTranscript({
    required String workspaceId,
    required String sessionId,
  }) {}
}

class _FakeSessionRepository implements SessionRepository {
  _FakeSessionRepository({
    this.cached = const TranscriptCache(events: [], hasOlder: false),
    Future<TranscriptPage>? latest,
  }) : _latest =
           latest ??
           Future.value(
             const TranscriptPage(
               events: [],
               nextCursor: null,
               hasMore: false,
               insertedCount: 0,
             ),
           );

  final TranscriptCache cached;
  final Future<TranscriptPage> _latest;
  bool latestCompleted = false;
  int latestRequests = 0;

  @override
  Future<TranscriptCache> loadCachedTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) async => cached;

  @override
  Stream<List<TranscriptEvent>> watchTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
  }) => const Stream.empty();

  @override
  Future<TranscriptPage> fetchLatestTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    int limit = 50,
  }) async {
    latestRequests += 1;
    final page = await _latest;
    latestCompleted = true;
    return page;
  }

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
