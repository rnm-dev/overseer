import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_highlight/flutter_highlight.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/shared/design/theme.dart';
import 'package:overseer_mobile/shared/widgets/file_view_block.dart';

void main() {
  testWidgets('renders Markdown bytes without project-domain dependencies', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: FileViewBlock(
            path: 'README.md',
            bytes: Uint8List.fromList(
              utf8.encode('# Reusable\n\n```dart\nfinal value = 1;\n```\n'),
            ),
            contentType: 'text/markdown',
            mode: FileViewMode.preview,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Reusable'), findsOneWidget);
    expect(find.byKey(const Key('file-view-markdown-preview')), findsOneWidget);
    expect(find.byType(HighlightView), findsOneWidget);
  });

  testWidgets('exposes a reusable controlled mode switch', (tester) async {
    var selected = FileViewMode.preview;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: StatefulBuilder(
            builder: (context, setState) => FileViewModeSwitch(
              mode: selected,
              previewLabel: 'Read',
              onChanged: (mode) => setState(() => selected = mode),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Code'));
    await tester.pump();

    expect(selected, FileViewMode.source);
  });
}
