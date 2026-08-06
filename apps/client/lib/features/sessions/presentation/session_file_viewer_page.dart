import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/platform/html_preview_launcher.dart';
import '../../../shared/design/colors.dart';
import '../../../shared/design/typography.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_navigation_bar.dart';
import '../../../shared/widgets/file_view_block.dart';
import '../application/session_file_controller.dart';

class SessionFileViewerPage extends ConsumerStatefulWidget {
  const SessionFileViewerPage({super.key, required this.scope});

  final SessionFileScope scope;

  @override
  ConsumerState<SessionFileViewerPage> createState() =>
      _SessionFileViewerPageState();
}

class _SessionFileViewerPageState extends ConsumerState<SessionFileViewerPage> {
  late FileViewMode _mode = fileSupportsRichPreview(widget.scope.displayPath)
      ? FileViewMode.preview
      : FileViewMode.source;

  @override
  Widget build(BuildContext context) {
    final file = ref.watch(sessionFileControllerProvider(widget.scope));
    final htmlPreviewLauncher = ref.watch(htmlPreviewLauncherProvider);
    final path = widget.scope.displayPath;
    final switchable = isMarkdownFile(path) || isHtmlFile(path);
    return Scaffold(
      key: const Key('session-file-viewer-page'),
      backgroundColor: AppThemePalette.of(context).canvas,
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            AppNavigationBar(
              showBackButton: true,
              contentPadding: const EdgeInsets.fromLTRB(8, 8, 8, 6),
              left: Row(
                children: [
                  Icon(
                    fileViewerIconForPath(path),
                    size: 16,
                    color: AppThemePalette.of(context).warning,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      path,
                      key: const Key('session-file-viewer-title'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppTypography.mono(
                        fontSize: 11,
                        color: AppThemePalette.of(context).inkMuted,
                      ),
                    ),
                  ),
                ],
              ),
              right: switchable
                  ? FileViewModeSwitch(
                      mode: _mode,
                      previewLabel: isMarkdownFile(path) ? 'Read' : 'Preview',
                      onChanged: (mode) => setState(() => _mode = mode),
                    )
                  : null,
            ),
            if (file.value?.truncated == true)
              Container(
                width: double.infinity,
                color: AppThemePalette.of(
                  context,
                ).warningStrong.withValues(alpha: 0.08),
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 6,
                ),
                child: Text(
                  'Preview truncated by the Peon',
                  style: AppTypography.mono(
                    fontSize: 10,
                    color: AppThemePalette.of(context).warningStrong,
                  ),
                ),
              ),
            Expanded(
              child: file.when(
                loading: () => Center(
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: AppThemePalette.of(context).accentStrong,
                  ),
                ),
                error: (error, _) => _ViewerError(
                  message: error.toString(),
                  onRetry: () => ref.invalidate(
                    sessionFileControllerProvider(widget.scope),
                  ),
                ),
                data: (preview) => FileViewBlock(
                  path: preview.path,
                  bytes: preview.bytes,
                  contentType: preview.contentType,
                  mode: _mode,
                  onOpenDesktopHtmlPreview: htmlPreviewLauncher.supported
                      ? (document) => htmlPreviewLauncher.open(
                          title: preview.path,
                          document: document,
                        )
                      : null,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ViewerError extends StatelessWidget {
  const _ViewerError({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              LucideIcons.triangleAlert,
              size: 30,
              color: AppThemePalette.of(context).inkFaint,
            ),
            const SizedBox(height: 12),
            Text(
              'Couldn’t open file',
              style: AppTypography.display(
                fontSize: 15,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              message,
              textAlign: TextAlign.center,
              style: AppTypography.body(
                fontSize: 13,
                color: AppThemePalette.of(context).inkFaint,
              ),
            ),
            const SizedBox(height: 16),
            AppButton(
              key: const Key('session-file-viewer-retry'),
              onPressed: onRetry,
              variant: AppButtonVariant.secondary,
              size: AppButtonSize.sm,
              child: const Text('Retry'),
            ),
          ],
        ),
      ),
    );
  }
}
