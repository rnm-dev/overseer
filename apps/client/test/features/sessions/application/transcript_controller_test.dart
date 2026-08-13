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

import '../../../support/manual_app_time.dart';
import 'package:overseer_mobile/core/time/app_time.dart';

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
    'opens only the newest cached page and reveals older cache on demand',
    () async {
      final repository = _FakeSessionRepository(
        cached: TranscriptCache(
          events: [
            for (var index = 0; index < 75; index++)
              TranscriptEvent(
                eventId: 'cached-$index',
                orderKey: index,
                payload: index == 0 || index == 74
                    ? const {'type': 'user_message', 'text': 'hello'}
                    : const {'type': 'assistant'},
              ),
          ],
          hasOlder: false,
        ),
      );
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

      final opened = await container.read(
        transcriptControllerProvider(scope).future,
      );
      expect(opened.events, hasLength(50));
      expect(opened.events.first.eventId, 'cached-25');
      expect(opened.events.where((event) => event.isUserMessage), hasLength(1));
      expect(opened.userMessageCount, 2);
      expect(opened.hasOlder, isTrue);

      while (container
              .read(transcriptControllerProvider(scope))
              .value
              ?.isRefreshing ==
          true) {
        await Future<void>.delayed(Duration.zero);
      }
      await container
          .read(transcriptControllerProvider(scope).notifier)
          .loadOlder();

      final expanded = container
          .read(transcriptControllerProvider(scope))
          .requireValue;
      expect(expanded.events, hasLength(75));
      expect(expanded.events.first.eventId, 'cached-0');
      expect(expanded.hasOlder, isFalse);
    },
  );

  test(
    'coalesces an authoritative post-submit refresh behind an opening refresh',
    () async {
      final opening = Completer<TranscriptPage>();
      final afterSubmit = Completer<TranscriptPage>();
      final repository = _SequencedTranscriptRepository([
        opening.future,
        afterSubmit.future,
      ]);
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
      while (repository.latestRequests < 1) {
        await Future<void>.delayed(Duration.zero);
      }

      await container
          .read(transcriptControllerProvider(scope).notifier)
          .refreshAfterSubmission();
      expect(repository.latestRequests, 1);

      opening.complete(_emptyTranscriptPage);
      while (repository.latestRequests < 2) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(repository.latestRequests, 2);

      afterSubmit.complete(_emptyTranscriptPage);
      await Future<void>.delayed(Duration.zero);
    },
  );

  test(
    'subscribes from the newest page after latest transcript refresh completes',
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
      while (repository.latestRequests < 1) {
        await Future<void>.delayed(Duration.zero);
      }

      expect(live.subscriptions, isEmpty);
      expect(repository.latestCompleted, isFalse);

      latest.complete(
        TranscriptPage(
          events: [
            TranscriptEvent(
              eventId: 'cached-7',
              orderKey: 7,
              payload: {'type': 'assistant'},
            ),
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

      expect(live.subscriptions, ['latest-9']);
    },
  );

  test(
    'fills a disjoint offline gap before subscribing to the live tail',
    () async {
      final repository = _GapSessionRepository();
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

      expect(repository.olderCursors, ['before-latest', 'before-gap']);
      expect(live.subscriptions, ['latest-2']);
      expect(
        container
            .read(transcriptControllerProvider(scope))
            .requireValue
            .hasOlder,
        isFalse,
      );
    },
  );

  test('re-anchors without a boundary when latest refresh fails', () async {
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
    while (repository.latestRequests < 1) {
      await Future<void>.delayed(Duration.zero);
    }
    latest.completeError(
      const SessionsException('Latest transcript unavailable.'),
    );
    while (live.subscriptions.isEmpty) {
      await Future<void>.delayed(Duration.zero);
    }

    expect(live.subscriptions, [null]);
  });

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

  test('every terminal tail failure forces immediate REST recovery', () async {
    final repository = _FakeSessionRepository();
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
    while (live.onFrame == null || repository.latestRequests < 1) {
      await Future<void>.delayed(Duration.zero);
    }

    await live.onFrame!(
      const TranscriptTailFrame.terminal(
        retryable: true,
        error: 'stream interrupted',
      ),
    );
    await live.onFrame!(
      const TranscriptTailFrame.terminal(
        retryable: true,
        error: 'stream interrupted again',
      ),
    );

    expect(repository.detailsRequests, 2);
    expect(repository.latestRequests, 3);
  });

  test(
    'does not acknowledge a malformed tail event unless REST recovered it',
    () async {
      final repository = _FakeSessionRepository();
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
      while (live.onFrame == null || repository.latestRequests < 1) {
        await Future<void>.delayed(Duration.zero);
      }

      await expectLater(
        live.onFrame!(
          const TranscriptTailFrame.event(
            eventId: 'malformed-event',
            data: '{not-json',
          ),
        ),
        throwsA(isA<SessionsException>()),
      );
      expect(repository.latestRequests, 2);
    },
  );

  test(
    'transcript recovery continues when session details are unavailable',
    () async {
      final repository = _FakeSessionRepository(detailsFail: true);
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
      while (live.onFrame == null || repository.latestRequests < 1) {
        await Future<void>.delayed(Duration.zero);
      }

      await live.onFrame!(
        const TranscriptTailFrame.terminal(
          retryable: true,
          error: 'stream interrupted',
        ),
      );

      expect(repository.detailsRequests, 1);
      expect(repository.latestRequests, 2);
    },
  );

  test(
    'periodically reconciles an idle transcript as an anti-entropy backstop',
    () async {
      const idleScope = TranscriptScope(
        workspaceId: 'workspace',
        peonId: 'peon',
        sessionId: 'idle-session',
      );
      final repository = _FakeSessionRepository();
      final clock = MutableAppClock(DateTime.utc(2026, 7, 27));
      final scheduler = ManualAppScheduler(clock: clock);
      final container = ProviderContainer(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(repository),
          appClockProvider.overrideWithValue(clock),
          appSchedulerProvider.overrideWithValue(scheduler),
        ],
      );
      addTearDown(container.dispose);
      final subscription = container.listen(
        transcriptControllerProvider(idleScope),
        (_, _) {},
        fireImmediately: true,
      );
      addTearDown(subscription.close);

      await container.read(transcriptControllerProvider(idleScope).future);
      while (!repository.latestCompleted) {
        await Future<void>.delayed(Duration.zero);
      }
      await scheduler.advance(const Duration(seconds: 5));

      expect(repository.detailsRequests, 1);
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

  test(
    'keeps replayed unread completion silent when opening session',
    () async {
      final latest = Completer<TranscriptPage>();
      final repository = _FakeSessionRepository(
        cached: TranscriptCache(
          events: [
            TranscriptEvent(
              eventId: 'cached-1',
              orderKey: 1,
              payload: {'type': 'assistant'},
            ),
          ],
          hasOlder: false,
        ),
        latest: latest.future,
      );
      final live = _FakeTranscriptLiveService();
      final sounds = _RecordingWorkSoundPlayer();
      final container = ProviderContainer(
        overrides: [
          sessionRepositoryProvider.overrideWithValue(repository),
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
      while (repository.latestRequests < 1) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(sounds.cues, isEmpty);

      latest.complete(
        TranscriptPage(
          events: [
            TranscriptEvent(
              eventId: 'unread-result',
              orderKey: 2,
              payload: {'type': 'result', 'is_error': false},
            ),
          ],
          nextCursor: null,
          hasMore: false,
          insertedCount: 1,
        ),
      );
      while (!repository.latestCompleted) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(live.subscriptions, ['unread-result']);
      expect(sounds.cues, isEmpty);

      await live.onFrame!(
        const TranscriptTailFrame.event(
          eventId: 'unread-result',
          data: '{"type":"result","is_error":false}',
        ),
      );
      expect(sounds.cues, isEmpty);

      await live.onFrame!(
        const TranscriptTailFrame.event(
          eventId: 'fresh-result',
          data: '{"type":"result","is_error":false}',
        ),
      );
      expect(sounds.cues, [(SoundPack.peon, WorkSoundCue.complete)]);
    },
  );

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
    this.detailsFail = false,
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
  final bool detailsFail;
  final Future<TranscriptPage> _latest;
  bool latestCompleted = false;
  int latestRequests = 0;
  int detailsRequests = 0;

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
  }) async {
    detailsRequests += 1;
    if (detailsFail) {
      throw const SessionsException('Session details unavailable.');
    }
    return const SessionDetails(turnCount: 1, status: 'completed');
  }

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

const _emptyTranscriptPage = TranscriptPage(
  events: [],
  nextCursor: null,
  hasMore: false,
  insertedCount: 0,
);

class _SequencedTranscriptRepository extends _FakeSessionRepository {
  _SequencedTranscriptRepository(this.pages);

  final List<Future<TranscriptPage>> pages;
  int _nextPage = 0;

  @override
  Future<TranscriptPage> fetchLatestTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    int limit = 50,
  }) {
    latestRequests += 1;
    return pages[_nextPage++];
  }
}

class _GapSessionRepository extends _FakeSessionRepository {
  _GapSessionRepository()
    : super(
        cached: TranscriptCache(
          events: [
            TranscriptEvent(
              eventId: 'cached-anchor',
              orderKey: 0,
              payload: const {'type': 'assistant'},
            ),
          ],
          hasOlder: false,
        ),
      );

  final List<String> olderCursors = [];

  @override
  Future<TranscriptPage> fetchLatestTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    int limit = 50,
  }) async => TranscriptPage(
    events: [
      TranscriptEvent(
        eventId: 'latest-1',
        orderKey: 3,
        payload: const {'type': 'assistant'},
      ),
      TranscriptEvent(
        eventId: 'latest-2',
        orderKey: 4,
        payload: const {'type': 'result'},
      ),
    ],
    nextCursor: 'before-latest',
    hasMore: true,
    insertedCount: 2,
  );

  @override
  Future<TranscriptPage> fetchOlderTranscript({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String cursor,
    int limit = 50,
  }) async {
    olderCursors.add(cursor);
    if (cursor == 'before-latest') {
      return TranscriptPage(
        events: [
          TranscriptEvent(
            eventId: 'missed',
            orderKey: 2,
            payload: const {'type': 'assistant'},
          ),
        ],
        nextCursor: 'before-gap',
        hasMore: true,
        insertedCount: 1,
      );
    }
    return TranscriptPage(
      events: [
        TranscriptEvent(
          eventId: 'cached-anchor',
          orderKey: 0,
          payload: const {'type': 'assistant'},
        ),
        TranscriptEvent(
          eventId: 'bridge',
          orderKey: 1,
          payload: const {'type': 'assistant'},
        ),
      ],
      nextCursor: null,
      hasMore: false,
      insertedCount: 1,
    );
  }
}
