import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_highlight/flutter_highlight.dart';
import 'package:flutter/services.dart';
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

  testWidgets('renders unlabeled Markdown fences as plaintext', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: FileViewBlock(
            path: 'CONTRIBUTING.md',
            bytes: Uint8List.fromList(
              utf8.encode('## Runtime layout\n\n```\npackages/example\n```\n'),
            ),
            contentType: 'text/markdown',
            mode: FileViewMode.preview,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final highlighter = tester.widget<HighlightView>(
      find.byType(HighlightView),
    );
    expect(highlighter.language, 'plaintext');
    expect(highlighter.source, contains('packages/example'));
    expect(tester.takeException(), isNull);
  });

  testWidgets('renders unknown file extensions as plaintext', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: FileViewBlock(
            path: 'example.unknown-language',
            bytes: Uint8List.fromList(utf8.encode('plain content')),
            mode: FileViewMode.source,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      tester.widget<HighlightView>(find.byType(HighlightView)).language,
      'plaintext',
    );
    expect(tester.takeException(), isNull);
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

  testWidgets('opens an isolated HTML document in the desktop preview', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.windows;
    try {
      await _loadGoldenFonts();
      String? openedDocument;

      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: FileViewBlock(
              path: 'index.html',
              bytes: Uint8List.fromList(utf8.encode('<h1>Desktop</h1>')),
              contentType: 'text/html',
              mode: FileViewMode.preview,
              onOpenDesktopHtmlPreview: (document) async {
                openedDocument = document;
              },
            ),
          ),
        ),
      );

      expect(
        find.byKey(const Key('file-view-html-external-preview')),
        findsOneWidget,
      );
      await expectLater(
        find.byKey(const Key('file-view-html-external-preview')),
        matchesGoldenFile('goldens/file_view_html_external_preview.png'),
      );
      await tester.tap(find.byKey(const Key('file-view-html-open-preview')));
      await tester.pump();

      expect(openedDocument, contains('<h1>Desktop</h1>'));
      expect(openedDocument, contains('Content-Security-Policy'));
      expect(openedDocument, contains("default-src 'none'"));
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  });
}

Future<void> _loadGoldenFonts() async {
  final golos = FontLoader('Golos Text')
    ..addFont(rootBundle.load('assets/fonts/golos_text/GolosText-Regular.ttf'))
    ..addFont(rootBundle.load('assets/fonts/golos_text/GolosText-Medium.ttf'))
    ..addFont(rootBundle.load('assets/fonts/golos_text/GolosText-SemiBold.ttf'))
    ..addFont(rootBundle.load('assets/fonts/golos_text/GolosText-Bold.ttf'));
  final lucide = FontLoader('packages/lucide_icons_flutter/Lucide')
    ..addFont(
      rootBundle.load('packages/lucide_icons_flutter/assets/lucide.ttf'),
    );
  await Future.wait([golos.load(), lucide.load()]);
}
