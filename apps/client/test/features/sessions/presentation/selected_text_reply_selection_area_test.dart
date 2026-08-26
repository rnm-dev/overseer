import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/sessions/domain/session_models.dart';
import 'package:overseer_mobile/features/sessions/presentation/selected_text_reply_selection_area.dart';

void main() {
  const reply = SelectedTextReply(
    eventId: 'assistant_1',
    selectedText: 'quoted context',
  );

  test('keeps every standard item and adds Reply first for a valid action', () {
    final standardItems = [
      ContextMenuButtonItem(
        type: ContextMenuButtonType.copy,
        label: 'Copy',
        onPressed: () {},
      ),
      ContextMenuButtonItem(
        type: ContextMenuButtonType.selectAll,
        label: 'Select all',
        onPressed: () {},
      ),
    ];
    var activations = 0;
    final items = selectedTextReplyContextMenuItems(
      standardItems: standardItems,
      reply: reply,
      onReply: () => activations++,
    );

    expect(items.map((item) => item.type), [
      ContextMenuButtonType.custom,
      ContextMenuButtonType.copy,
      ContextMenuButtonType.selectAll,
    ]);
    expect(items.map((item) => item.label), ['Reply', 'Copy', 'Select all']);
    items.first.onPressed!();
    expect(activations, 1);
  });

  test('capability-off/null action leaves standard items unchanged', () {
    final standardItems = [
      ContextMenuButtonItem(
        type: ContextMenuButtonType.copy,
        label: 'Copy',
        onPressed: () {},
      ),
    ];
    final items = selectedTextReplyContextMenuItems(
      standardItems: standardItems,
      reply: reply,
      onReply: null,
    );

    expect(items, hasLength(1));
    expect(items.single.type, ContextMenuButtonType.copy);
    expect(items.where((item) => item.label == 'Reply'), isEmpty);

    final invalidSelectionItems = selectedTextReplyContextMenuItems(
      standardItems: standardItems,
      reply: null,
      onReply: () {},
    );
    expect(invalidSelectionItems, hasLength(1));
    expect(invalidSelectionItems.single.type, ContextMenuButtonType.copy);
  });

  testWidgets('selection changes alone never call the reply callback', (
    tester,
  ) async {
    var replies = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SelectedTextReplySelectionArea(
            eventId: 'assistant_1',
            onReply: (_) => replies++,
            child: Text('quoted context'),
          ),
        ),
      ),
    );

    // The selection widget receives this callback only when the user changes
    // selection; the actual Reply menu item is the sole activation path.
    await tester.longPress(find.text('quoted context'));
    await tester.pump();
    expect(replies, 0);
  });
}
