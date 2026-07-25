import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/sessions/domain/session_models.dart';
import 'package:overseer_mobile/features/sessions/presentation/transcript_item_view.dart';
import 'package:overseer_mobile/features/sessions/presentation/transcript_items.dart';
import 'package:overseer_mobile/shared/design/theme.dart';

void main() {
  test('flattens assistant blocks and pairs a later tool result', () {
    final items = flattenTranscriptEvents([
      _event('user-message', 0, {
        'type': 'user_message',
        'text': 'Inspect the cache',
        'authorEmail': 'operator@example.com',
      }),
      _event('assistant', 1, {
        'type': 'assistant',
        'message': {
          'content': [
            {'type': 'thinking', 'thinking': 'I should inspect the schema.'},
            {
              'type': 'tool_use',
              'id': 'tool-1',
              'name': 'Read',
              'input': {'file_path': 'lib/cache.dart'},
            },
            {'type': 'text', 'text': 'The cache is durable.'},
          ],
        },
      }),
      _event('tool-result', 2, {
        'type': 'user',
        'message': {
          'role': 'user',
          'content': [
            {
              'type': 'tool_result',
              'tool_use_id': 'tool-1',
              'content': '42 rows',
            },
          ],
        },
      }),
    ]);

    expect(items, hasLength(4));
    expect(items[0], isA<TranscriptUserItem>());
    expect(items[1], isA<TranscriptThinkingItem>());
    final tool = items[2] as TranscriptToolItem;
    expect(tool.name, 'Read');
    expect(
      transcriptToolSummary(tool.input, name: tool.name),
      'lib/cache.dart',
    );
    expect(tool.result?.text, '42 rows');
    expect(tool.result?.isError, isFalse);
    expect(items[3], isA<TranscriptTextItem>());
    expect(
      items.whereType<TranscriptRawItem>(),
      isEmpty,
      reason: 'Anthropic tool result events must not render as raw user rows.',
    );
  });

  test('hides noisy events and attaches run metadata to the last answer', () {
    final items = flattenTranscriptEvents([
      _event('system', 0, {'type': 'system', 'text': 'reinitialized'}),
      _event('assistant', 1, {
        'type': 'assistant',
        'createdAt': 1700000000000,
        'message': {
          'content': [
            {'type': 'text', 'text': 'Done.'},
          ],
        },
      }),
      _event('result', 2, {
        'type': 'result',
        'duration_ms': 12100,
        'num_turns': 3,
        'total_cost_usd': 0.04,
        'usage': {'output_tokens': 1240},
      }),
      _event('rate-limit', 3, {'type': 'rate_limit_event'}),
    ]);

    expect(items, hasLength(1));
    final answer = items.single as TranscriptTextItem;
    expect(answer.text, 'Done.');
    expect(answer.resultMeta?.text, '12s · 3 turns · \$0.04 · 1.2K output');
  });

  test('keeps an unmatched tool result visible as a standalone tool row', () {
    final items = flattenTranscriptEvents([
      _event('orphan', 0, {
        'type': 'user',
        'message': {
          'content': [
            {
              'type': 'tool_result',
              'tool_use_id': 'missing',
              'content': [
                {'type': 'text', 'text': 'permission denied'},
              ],
              'is_error': true,
            },
          ],
        },
      }),
    ]);

    final tool = items.single as TranscriptToolItem;
    expect(tool.result?.text, 'permission denied');
    expect(tool.result?.isError, isTrue);
  });

  test('derives edit operation and line stats from Codex changes', () {
    final input = {
      'changes': [
        {
          'kind': {'type': 'update'},
          'path': 'lib/session.dart',
          'diff': '@@ -1,2 +1,3 @@\n context\n-old\n+new\n+another',
        },
      ],
    };

    expect(transcriptEditOperation(input), TranscriptEditOperation.edit);
    final stats = transcriptEditStats(input);
    expect(stats?.added, 2);
    expect(stats?.removed, 1);
  });

  test('counts raw whole-file create and delete payloads', () {
    final create = {
      'changes': [
        {'kind': 'add', 'diff': 'first\nsecond\n'},
      ],
    };
    final delete = {
      'changes': [
        {'kind': 'delete', 'diff': 'first\nsecond\nthird'},
      ],
    };

    expect(transcriptEditOperation(create), TranscriptEditOperation.create);
    expect(transcriptEditStats(create)?.added, 2);
    expect(transcriptEditStats(create)?.removed, 0);
    expect(transcriptEditOperation(delete), TranscriptEditOperation.delete);
    expect(transcriptEditStats(delete)?.added, 0);
    expect(transcriptEditStats(delete)?.removed, 3);
  });

  test('keeps same-side rows compact and separates turn boundaries', () {
    final firstAssistant = TranscriptTextItem(key: 'a', text: 'First');
    const secondAssistant = TranscriptToolItem(key: 'b', name: 'Read');
    const firstUser = TranscriptUserItem(key: 'u1', text: 'One');
    const secondUser = TranscriptUserItem(key: 'u2', text: 'Two');

    expect(transcriptItemGap(null, firstAssistant), 0);
    expect(transcriptItemGap(firstAssistant, secondAssistant), 6);
    expect(transcriptItemGap(firstUser, secondUser), 3);
    expect(transcriptItemGap(secondAssistant, firstUser), 16);
    expect(transcriptItemGap(firstUser, firstAssistant), 16);
  });

  testWidgets('short user messages use content-sized bubbles', (tester) async {
    const item = TranscriptUserItem(key: 'short', text: 'OK');
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: const Scaffold(
          body: SizedBox(width: 400, child: TranscriptItemView(item: item)),
        ),
      ),
    );

    final bubbleSize = tester.getSize(
      find.byKey(const Key('transcript-user-short')),
    );
    expect(bubbleSize.width, lessThan(160));
  });

  test('derives working activity from the freshest assistant block', () {
    final bash = _event('bash', 0, {
      'type': 'assistant',
      'createdAt': 1700000000000,
      'message': {
        'content': [
          {'type': 'text', 'text': 'Starting.'},
          {
            'type': 'tool_use',
            'name': 'Bash',
            'input': {'command': 'flutter test'},
          },
        ],
      },
    });
    final writing = _event('writing', 1, {
      'type': 'assistant',
      'message': {
        'content': [
          {'type': 'text', 'text': 'Writing the answer.'},
        ],
      },
    });

    expect(transcriptWorkingActivity(bash).label, 'Running a command…');
    expect(transcriptWorkingActivity(bash).startedAt, 1700000000000);
    expect(transcriptWorkingActivity(writing).label, 'Agent is writing…');
    expect(transcriptWorkingActivity(null).label, isNotEmpty);
  });

  testWidgets('renders compact edit stats and dotted Details control', (
    tester,
  ) async {
    const item = TranscriptToolItem(
      key: 'edit',
      name: 'Edit',
      input: {
        'file_path': 'lib/session.dart',
        'changes': [
          {'kind': 'update', 'diff': '@@ -1,2 +1,3 @@\n-old\n+new\n+another'},
        ],
      },
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: const Scaffold(body: TranscriptItemView(item: item)),
      ),
    );

    final edit = tester.widget<Text>(find.text('Edit'));
    expect(edit.style?.fontSize, 10);
    expect(find.text('(+2,−1)', findRichText: true), findsOneWidget);
    final details = tester.widget<Text>(find.text('Details'));
    expect(details.style?.fontSize, 10);
    expect(details.style?.decoration, TextDecoration.underline);
    expect(details.style?.decorationStyle, TextDecorationStyle.dotted);

    await tester.tap(find.byKey(const Key('transcript-tool-details-edit')));
    await tester.pumpAndSettle();

    expect(find.text('session.dart'), findsOneWidget);
    expect(find.byKey(const Key('tool-details-diff')), findsOneWidget);
    expect(find.text('old'), findsOneWidget);
    expect(find.text('new'), findsOneWidget);
    expect(find.text('OUTPUT'), findsNothing);
    expect(find.text('(−1,+2)', findRichText: true), findsOneWidget);
  });

  testWidgets('opens transcript attachments and preview artifacts', (
    tester,
  ) async {
    TranscriptAttachment? openedAttachment;
    TranscriptPreviewItem? openedPreview;
    const attachment = TranscriptAttachment(
      type: 'image',
      path: 'uploads/command/image.png',
      name: 'image.png',
    );
    const user = TranscriptUserItem(
      key: 'user-with-file',
      text: 'See this',
      attachments: [attachment],
    );
    const preview = TranscriptPreviewItem(
      key: 'artifact-preview',
      path: 'reports/result.md',
    );

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Column(
            children: [
              TranscriptItemView(
                item: user,
                onOpenAttachment: (value) => openedAttachment = value,
              ),
              TranscriptItemView(
                item: preview,
                onOpenPreview: (value) => openedPreview = value,
              ),
            ],
          ),
        ),
      ),
    );

    await tester.tap(find.byKey(const Key('transcript-attachment-image.png')));
    await tester.tap(
      find.byKey(const Key('transcript-preview-artifact-preview')),
    );

    expect(openedAttachment, same(attachment));
    expect(openedPreview, same(preview));
  });

  testWidgets('tool Details sheet shows command and formatted JSON output', (
    tester,
  ) async {
    const item = TranscriptToolItem(
      key: 'bash',
      name: 'Bash',
      input: {'command': 'flutter test'},
      result: TranscriptToolResult(
        text: '{"passed":true,"count":2}',
        isError: false,
      ),
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: const Scaffold(body: TranscriptItemView(item: item)),
      ),
    );

    await tester.tap(find.byKey(const Key('transcript-tool-details-bash')));
    await tester.pumpAndSettle();

    expect(find.text('Bash'), findsWidgets);
    expect(find.text('COMMAND'), findsOneWidget);
    expect(find.text('OUTPUT'), findsOneWidget);
    expect(find.text('flutter test'), findsWidgets);
    expect(find.text('{\n  "passed": true,\n  "count": 2\n}'), findsOneWidget);
  });

  test('edit details derive file names and numbered replacement lines', () {
    expect(
      transcriptEditFileName({
        'changes': [
          {'path': 'lib/one.dart'},
          {'path': 'lib/two.dart'},
        ],
      }),
      'one.dart (+1)',
    );
    final diff = transcriptEditDiff({
      'old_string': 'same\nold',
      'new_string': 'same\nnew',
    });
    expect(diff, isNotNull);
    expect(diff![0].kind, TranscriptDiffLineKind.context);
    expect(diff[0].oldLine, 1);
    expect(diff[0].newLine, 1);
    expect(
      diff
          .where((line) => line.kind == TranscriptDiffLineKind.remove)
          .single
          .text,
      'old',
    );
    expect(
      diff.where((line) => line.kind == TranscriptDiffLineKind.add).single.text,
      'new',
    );
  });
}

TranscriptEvent _event(
  String eventId,
  int orderKey,
  Map<String, dynamic> payload,
) {
  return TranscriptEvent(
    eventId: eventId,
    orderKey: orderKey,
    payload: {'eventId': eventId, ...payload},
  );
}
