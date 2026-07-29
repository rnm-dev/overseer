import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/platform/html_preview_launcher.dart';
import '../../../shared/design/colors.dart';
import '../../../shared/design/typography.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_navigation_bar.dart';
import '../../../shared/widgets/file_view_block.dart';
import '../application/project_file_viewer_controller.dart';

class ProjectFileViewerPage extends ConsumerStatefulWidget {
  const ProjectFileViewerPage({
    super.key,
    required this.workspaceId,
    required this.peonId,
    required this.projectKey,
    required this.path,
    this.projectId,
  });

  final String workspaceId;
  final String peonId;
  final String projectKey;
  final String path;
  final String? projectId;

  @override
  ConsumerState<ProjectFileViewerPage> createState() =>
      _ProjectFileViewerPageState();
}

class _ProjectFileViewerPageState extends ConsumerState<ProjectFileViewerPage> {
  late FileViewMode _mode = fileSupportsRichPreview(widget.path)
      ? FileViewMode.preview
      : FileViewMode.source;

  ProjectFileViewerScope get _scope => ProjectFileViewerScope(
    workspaceId: widget.workspaceId,
    peonId: widget.peonId,
    projectKey: widget.projectKey,
    projectId: widget.projectId,
    path: widget.path,
  );

  @override
  Widget build(BuildContext context) {
    final file = ref.watch(projectFileViewerControllerProvider(_scope));
    final htmlPreviewLauncher = ref.watch(htmlPreviewLauncherProvider);
    final switchable = isMarkdownFile(widget.path) || isHtmlFile(widget.path);
    return Scaffold(
      key: const Key('project-file-viewer-page'),
      backgroundColor: AppColors.background,
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            AppNavigationBar(
              key: const Key('project-file-viewer-navbar'),
              showBackButton: true,
              contentPadding: const EdgeInsets.fromLTRB(8, 8, 8, 6),
              left: Row(
                children: [
                  Icon(
                    fileViewerIconForPath(widget.path),
                    size: 16,
                    color: AppColors.forge,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      widget.path,
                      key: const Key('project-file-viewer-title'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppTypography.mono(
                        fontSize: 11,
                        color: AppColors.boneDim,
                      ),
                    ),
                  ),
                ],
              ),
              right: switchable
                  ? FileViewModeSwitch(
                      mode: _mode,
                      previewLabel: isMarkdownFile(widget.path)
                          ? 'Read'
                          : 'Preview',
                      onChanged: (mode) => setState(() => _mode = mode),
                    )
                  : null,
            ),
            Expanded(
              child: file.when(
                loading: () => const _ViewerLoading(),
                error: (error, _) => _ViewerMessage(
                  icon: LucideIcons.triangleAlert,
                  title: 'Couldn’t open file',
                  message: _errorMessage(error),
                  action: AppButton(
                    key: const Key('project-file-viewer-retry'),
                    onPressed: () => ref.invalidate(
                      projectFileViewerControllerProvider(_scope),
                    ),
                    variant: AppButtonVariant.secondary,
                    size: AppButtonSize.sm,
                    child: const Text('Retry'),
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

class _ViewerLoading extends StatelessWidget {
  const _ViewerLoading();

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: SizedBox.square(
        dimension: 24,
        child: CircularProgressIndicator(
          strokeWidth: 2,
          color: AppColors.felBright,
        ),
      ),
    );
  }
}

class _ViewerMessage extends StatelessWidget {
  const _ViewerMessage({
    required this.icon,
    required this.title,
    required this.message,
    this.action,
  });

  final IconData icon;
  final String title;
  final String message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 30, color: AppColors.boneFaint),
            const SizedBox(height: 12),
            Text(
              title,
              textAlign: TextAlign.center,
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
                color: AppColors.boneFaint,
              ),
            ),
            if (action != null) ...[const SizedBox(height: 16), action!],
          ],
        ),
      ),
    );
  }
}

String _errorMessage(Object error) {
  final value = error.toString();
  return value.startsWith('ProjectsException: ')
      ? value.substring('ProjectsException: '.length)
      : value;
}
