import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/sessions/domain/session_continuation_recovery.dart';
import 'package:overseer_mobile/features/sessions/domain/session_models.dart';

void main() {
  test('classifies Codex thread preparation failures', () {
    expect(
      sessionContinuationFailure(
        _event([
          'Codex app-server request thread/fork timed out after 30000ms',
        ]),
      ),
      SessionContinuationFailure.forkTimeout,
    );
    expect(
      sessionContinuationFailure(
        _event([
          'invalid paginated history lineage for abc: missing source rollout',
        ]),
      ),
      SessionContinuationFailure.missingHistory,
    );
    expect(sessionContinuationFailure(_event(['turn/start failed'])), isNull);
  });

  test('recovery prompt carries source and latest unexecuted request', () {
    final events = [
      _userEvent('old request', '1'),
      _userEvent('finish the task', '2'),
    ];
    final prompt = continuationRecoveryPrompt(
      sourceSessionId: 'session-1',
      sourceUrl: 'https://example.test/session-1',
      prompt: lastUnexecutedUserPrompt(events),
    );
    expect(prompt, contains('Source Peon session: session-1'));
    expect(prompt, contains('finish the task'));
    expect(prompt, contains('Do not attempt to fork or resume'));
  });
}

TranscriptEvent _event(List<String> errors) => TranscriptEvent(
  eventId: 'result',
  orderKey: 1,
  payload: {'type': 'result', 'is_error': true, 'errors': errors},
);

TranscriptEvent _userEvent(String text, String id) => TranscriptEvent(
  eventId: id,
  orderKey: int.parse(id),
  payload: {'type': 'user_message', 'text': text},
);
