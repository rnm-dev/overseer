import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/sessions/application/session_file_controller.dart';
import 'package:overseer_mobile/features/sessions/domain/session_file_repository.dart';
import 'package:overseer_mobile/features/sessions/presentation/session_file_viewer_page.dart';
import 'package:overseer_mobile/shared/design/theme.dart';

void main() {
  testWidgets('renders transcript attachment details with the shared viewer', (
    tester,
  ) async {
    final repository = _FileRepository();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionFileRepositoryProvider.overrideWithValue(repository),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const SessionFileViewerPage(
            scope: SessionFileScope.attachment(
              workspaceId: 'workspace',
              peonId: 'peon',
              sessionId: 'session',
              path: 'uploads/command/notes.md',
              name: 'notes.md',
              type: 'file',
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('session-file-viewer-page')), findsOneWidget);
    expect(find.text('notes.md'), findsOneWidget);
    expect(find.byKey(const Key('file-view-markdown-preview')), findsOneWidget);
    expect(repository.attachmentPath, 'uploads/command/notes.md');
  });

  testWidgets(
    'renders transcript preview artifacts through session file REST',
    (tester) async {
      final repository = _FileRepository();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sessionFileRepositoryProvider.overrideWithValue(repository),
          ],
          child: MaterialApp(
            theme: AppTheme.dark,
            home: const SessionFileViewerPage(
              scope: SessionFileScope.artifact(
                workspaceId: 'workspace',
                peonId: 'peon',
                sessionId: 'session',
                path: 'reports/result.md',
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('file-view-markdown-preview')),
        findsOneWidget,
      );
      expect(repository.artifactPath, 'reports/result.md');
    },
  );
}

class _FileRepository implements SessionFileRepository {
  String? attachmentPath;
  String? artifactPath;

  @override
  Future<SessionFilePreview> fetchArtifact({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String path,
  }) async {
    artifactPath = path;
    return SessionFilePreview(
      path: path,
      bytes: Uint8List.fromList('# Artifact'.codeUnits),
      contentType: 'text/markdown',
    );
  }

  @override
  Future<SessionFilePreview> fetchAttachment({
    required String workspaceId,
    required String peonId,
    required String path,
    required String name,
    String? type,
  }) async {
    attachmentPath = path;
    return SessionFilePreview(
      path: name,
      bytes: Uint8List.fromList('# Attachment'.codeUnits),
      contentType: 'text/markdown',
    );
  }
}
