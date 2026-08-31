import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/sessions/domain/session_models.dart';
import 'package:overseer_mobile/features/sessions/presentation/transcript_items.dart';

void main() {
  test(
    'selected-text replies round-trip and survive transcript flattening',
    () {
      const reply = SelectedTextReply(
        eventId: 'event_1',
        selectedText: 'quoted context',
      );
      expect(SelectedTextReply.fromJson(reply.toJson()), reply);

      final event = TranscriptEvent(
        eventId: 'event_2',
        orderKey: 2,
        payload: {
          'type': 'user_message',
          'text': 'follow up',
          'replyTo': reply.toJson(),
        },
      );
      expect(event.replyTo, reply);

      final items = flattenTranscriptEvents([event]);
      final user = items.single as TranscriptUserItem;
      expect(user.sourceEventId, 'event_2');
      expect(user.replyTo, reply);
    },
  );

  test('malformed selected-text reply is ignored in transcript payloads', () {
    final event = TranscriptEvent(
      eventId: 'event_1',
      orderKey: 1,
      payload: {
        'type': 'user_message',
        'text': 'follow up',
        'replyTo': {'eventId': '', 'selectedText': 'quoted context'},
      },
    );

    expect(event.replyTo, isNull);
  });

  test('live selections preserve exact text and enforce contract bounds', () {
    const selected = '  café\n🙂  ';
    expect(
      SelectedTextReply.fromSelection(
        eventId: 'assistant_1',
        selectedText: selected,
      ),
      const SelectedTextReply(eventId: 'assistant_1', selectedText: selected),
    );
    expect(
      SelectedTextReply.fromSelection(
        eventId: 'assistant_1',
        selectedText: '   \n',
      ),
      isNull,
    );
    expect(
      SelectedTextReply.fromSelection(
        eventId: 'assistant.1',
        selectedText: 'quoted',
      ),
      isNull,
    );
    expect(
      SelectedTextReply.fromSelection(
        eventId: 'assistant_1',
        selectedText: '🙂' * (SelectedTextReply.maxSelectedTextCodePoints + 1),
      ),
      isNull,
    );
    expect(
      SelectedTextReply.fromSelection(
        eventId: 'assistant_1',
        selectedText:
            '€' * (SelectedTextReply.maxSelectedTextUtf8Bytes ~/ 3 + 1),
      ),
      isNull,
      reason: 'UTF-8 byte bound is independent of the code-point bound',
    );
  });
}
