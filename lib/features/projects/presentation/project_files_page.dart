import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../shared/design/colors.dart';
import '../../../shared/design/typography.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_navigation_bar.dart';
import '../application/project_files_controller.dart';
import '../domain/project_models.dart';
import 'project_file_viewer_page.dart';

class ProjectFilesPage extends ConsumerWidget {
  const ProjectFilesPage({
    super.key,
    required this.workspaceId,
    required this.peonId,
    required this.projectKey,
    this.projectId,
  });

  final String workspaceId;
  final String peonId;
  final String? projectKey;
  final String? projectId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final key = projectKey?.trim();
    final scope = key == null || key.isEmpty
        ? null
        : ProjectFilesScope(
            workspaceId: workspaceId,
            peonId: peonId,
            projectKey: key,
          );
    final files = scope == null
        ? null
        : ref.watch(projectFilesControllerProvider(scope));
    final state = files?.value;

    return Scaffold(
      key: const Key('project-files-page'),
      backgroundColor: AppColors.background,
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            AppNavigationBar(
              key: const Key('project-files-navbar'),
              showBackButton: true,
              contentHeight: 56,
              contentPadding: const EdgeInsets.fromLTRB(8, 10, 8, 6),
              left: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Files',
                    style: AppTypography.display(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  if (key != null && key.isNotEmpty)
                    Text(
                      _titleize(key),
                      key: const Key('project-files-project'),
                      maxLines: 1,
                      overflow: TextOverflow.fade,
                      softWrap: false,
                      style: AppTypography.mono(
                        fontSize: 9,
                        color: AppColors.forge,
                        height: 1.2,
                      ),
                    ),
                ],
              ),
              right: scope == null
                  ? null
                  : IconButton(
                      key: const Key('project-files-refresh'),
                      tooltip: 'Refresh files',
                      onPressed: state?.refreshing == true
                          ? null
                          : () => ref
                                .read(
                                  projectFilesControllerProvider(
                                    scope,
                                  ).notifier,
                                )
                                .refresh(),
                      padding: EdgeInsets.zero,
                      constraints: const BoxConstraints.tightFor(
                        width: 40,
                        height: 40,
                      ),
                      icon: state?.refreshing == true
                          ? const SizedBox.square(
                              dimension: 16,
                              child: CircularProgressIndicator(
                                strokeWidth: 1.5,
                                color: AppColors.felBright,
                              ),
                            )
                          : const Icon(
                              LucideIcons.refreshCw,
                              size: 17,
                              color: AppColors.boneDim,
                            ),
                    ),
            ),
            Expanded(
              child: scope == null
                  ? const _FilesEmptyState(
                      icon: LucideIcons.folderX,
                      title: 'No project files',
                      message:
                          'This session is not linked to a project, so there '
                          'is no project tree to show.',
                    )
                  : files!.when(
                      data: (value) => ProjectFileTreeView(
                        state: value,
                        onToggle: (path) => ref
                            .read(
                              projectFilesControllerProvider(scope).notifier,
                            )
                            .toggleDirectory(path),
                        onRetry: (path) => ref
                            .read(
                              projectFilesControllerProvider(scope).notifier,
                            )
                            .retryDirectory(path),
                        onOpenFile: (path) => Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) => ProjectFileViewerPage(
                              workspaceId: workspaceId,
                              peonId: peonId,
                              projectKey: key!,
                              projectId: projectId,
                              path: path,
                            ),
                          ),
                        ),
                      ),
                      loading: () => const _TreeLoading(),
                      error: (_, _) => _FilesEmptyState(
                        icon: LucideIcons.triangleAlert,
                        title: 'Couldn’t load files',
                        message: 'The project tree is unavailable right now.',
                        action: AppButton(
                          key: const Key('project-files-retry'),
                          onPressed: () => ref.invalidate(
                            projectFilesControllerProvider(scope),
                          ),
                          variant: AppButtonVariant.secondary,
                          size: AppButtonSize.sm,
                          child: const Text('Retry'),
                        ),
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class ProjectFileTreeView extends StatelessWidget {
  const ProjectFileTreeView({
    super.key,
    required this.state,
    required this.onToggle,
    required this.onRetry,
    required this.onOpenFile,
  });

  final ProjectFilesState state;
  final ValueChanged<String> onToggle;
  final ValueChanged<String> onRetry;
  final ValueChanged<String>? onOpenFile;

  @override
  Widget build(BuildContext context) {
    final root = state.directories[''];
    if (root == null || root.loading) return const _TreeLoading();
    if (root.message != null) {
      return _FilesEmptyState(
        icon: LucideIcons.triangleAlert,
        title: 'Couldn’t load files',
        message: root.message!,
        action: AppButton(
          key: const Key('project-files-retry'),
          onPressed: () => onRetry(''),
          variant: AppButtonVariant.secondary,
          size: AppButtonSize.sm,
          child: const Text('Retry'),
        ),
      );
    }
    if (root.entries.isEmpty) {
      return const _FilesEmptyState(
        icon: LucideIcons.folder,
        title: 'Empty project',
        message: 'There are no files in this project yet.',
      );
    }

    final rows = <Widget>[];
    _appendDirectory(rows, '', 0);
    return ListView(
      key: const Key('project-file-tree'),
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 24),
      children: rows,
    );
  }

  void _appendDirectory(List<Widget> rows, String path, int depth) {
    final directory = state.directories[path];
    if (directory == null) return;
    if (directory.loading) {
      rows.add(_DirectoryLoading(depth: depth));
      return;
    }
    if (directory.message case final message?) {
      rows.add(
        _DirectoryError(
          depth: depth,
          message: message,
          onRetry: () => onRetry(path),
        ),
      );
      return;
    }
    for (final entry in directory.entries) {
      final fullPath = path.isEmpty ? entry.name : '$path/${entry.name}';
      final open = entry.isDirectory && state.expanded.contains(fullPath);
      rows.add(
        _FileTreeRow(
          key: ValueKey('project-file-$fullPath'),
          entry: entry,
          path: fullPath,
          depth: depth,
          open: open,
          onTap: entry.isDirectory ? () => onToggle(fullPath) : null,
          onOpenFile: entry.isDirectory || onOpenFile == null
              ? null
              : () => onOpenFile!(fullPath),
        ),
      );
      if (open) _appendDirectory(rows, fullPath, depth + 1);
    }
  }
}

class _FileTreeRow extends StatelessWidget {
  const _FileTreeRow({
    super.key,
    required this.entry,
    required this.path,
    required this.depth,
    required this.open,
    required this.onTap,
    required this.onOpenFile,
  });

  final ProjectFileEntry entry;
  final String path;
  final int depth;
  final bool open;
  final VoidCallback? onTap;
  final VoidCallback? onOpenFile;

  @override
  Widget build(BuildContext context) {
    final content = Padding(
      padding: EdgeInsets.fromLTRB(8 + depth * 16, 0, 8, 0),
      child: Row(
        children: [
          SizedBox(
            width: 18,
            child: entry.isDirectory
                ? AnimatedRotation(
                    turns: open ? 0.25 : 0,
                    duration: const Duration(milliseconds: 150),
                    child: const Icon(
                      LucideIcons.chevronRight,
                      size: 13,
                      color: AppColors.boneFaint,
                    ),
                  )
                : null,
          ),
          Icon(
            entry.isDirectory
                ? (open ? LucideIcons.folderOpen : LucideIcons.folder)
                : _fileIcon(entry.name),
            size: 16,
            color: entry.isDirectory ? AppColors.felDeep : AppColors.boneFaint,
          ),
          const SizedBox(width: 7),
          Expanded(
            child: Text(
              entry.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppTypography.mono(fontSize: 12, color: AppColors.boneDim),
            ),
          ),
          if (!entry.isDirectory && entry.size != null)
            Text(
              _formatFileSize(entry.size!),
              style: AppTypography.mono(
                fontSize: 10,
                color: AppColors.boneFaint,
              ),
            ),
        ],
      ),
    );
    final action = onTap ?? onOpenFile;
    if (action == null) {
      return SizedBox(height: 34, child: content);
    }
    return Semantics(
      button: true,
      label: entry.isDirectory
          ? '${open ? 'Collapse' : 'Expand'} $path'
          : 'Open $path',
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: action,
          borderRadius: BorderRadius.circular(6),
          child: SizedBox(height: 34, child: content),
        ),
      ),
    );
  }
}

class _DirectoryLoading extends StatelessWidget {
  const _DirectoryLoading({required this.depth});

  final int depth;

  @override
  Widget build(BuildContext context) {
    return Padding(
      key: const Key('project-directory-loading'),
      padding: EdgeInsets.only(left: 34 + depth * 16),
      child: const SizedBox(
        height: 34,
        child: Align(
          alignment: Alignment.centerLeft,
          child: SizedBox.square(
            dimension: 14,
            child: CircularProgressIndicator(
              strokeWidth: 1.5,
              color: AppColors.felBright,
            ),
          ),
        ),
      ),
    );
  }
}

class _DirectoryError extends StatelessWidget {
  const _DirectoryError({
    required this.depth,
    required this.message,
    required this.onRetry,
  });

  final int depth;
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(34 + depth * 16, 4, 8, 4),
      child: Row(
        children: [
          const Icon(
            LucideIcons.triangleAlert,
            size: 14,
            color: AppColors.blood,
          ),
          const SizedBox(width: 7),
          Expanded(
            child: Text(
              message,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: AppTypography.mono(fontSize: 10, color: AppColors.blood),
            ),
          ),
          IconButton(
            tooltip: 'Retry folder',
            onPressed: onRetry,
            icon: const Icon(LucideIcons.refreshCw, size: 15),
          ),
        ],
      ),
    );
  }
}

class _TreeLoading extends StatelessWidget {
  const _TreeLoading();

  @override
  Widget build(BuildContext context) {
    return ListView(
      key: const Key('project-files-loading'),
      padding: const EdgeInsets.all(16),
      children: List.generate(
        6,
        (index) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 9),
          child: Row(
            children: [
              const SizedBox(
                width: 16,
                height: 16,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: AppColors.iron700,
                    borderRadius: BorderRadius.all(Radius.circular(3)),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: FractionallySizedBox(
                    widthFactor: 0.45 + (index % 3) * 0.12,
                    child: const SizedBox(
                      height: 10,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: AppColors.iron800,
                          borderRadius: BorderRadius.all(Radius.circular(8)),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _FilesEmptyState extends StatelessWidget {
  const _FilesEmptyState({
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
            Icon(icon, size: 28, color: AppColors.boneFaint),
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

IconData _fileIcon(String name) {
  final extension = name.contains('.')
      ? name.split('.').last.toLowerCase()
      : '';
  return switch (extension) {
    'dart' ||
    'js' ||
    'ts' ||
    'tsx' ||
    'jsx' ||
    'swift' ||
    'kt' => LucideIcons.fileCode,
    'md' || 'txt' || 'log' => LucideIcons.fileText,
    'png' ||
    'jpg' ||
    'jpeg' ||
    'gif' ||
    'webp' ||
    'svg' => LucideIcons.fileImage,
    'json' || 'yaml' || 'yml' || 'toml' => LucideIcons.fileJson,
    _ => LucideIcons.file,
  };
}

String _formatFileSize(int size) {
  if (size < 1024) return '$size B';
  if (size < 1024 * 1024) return '${(size / 1024).round()} KB';
  return '${(size / (1024 * 1024)).toStringAsFixed(1)} MB';
}

String _titleize(String value) {
  return value
      .split(RegExp(r'[-_]+'))
      .where((part) => part.isNotEmpty)
      .map(
        (part) => '${part.substring(0, 1).toUpperCase()}${part.substring(1)}',
      )
      .join(' ');
}
