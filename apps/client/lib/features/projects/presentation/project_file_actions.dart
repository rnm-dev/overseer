import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../shared/design/typography.dart';
import '../../../shared/widgets/app_option_bottom_sheet.dart';
import '../application/project_files_controller.dart';
import '../application/projects_controller.dart';
import '../domain/project_models.dart';

/// The operator-facing transfer actions of one project tree: the long-press
/// menus, picking and uploading files, saving a file to the device, and
/// moving entries. Both the Files page and the project Files tab use it, so
/// the wording and refusals stay identical wherever the tree appears.
class ProjectFileActions {
  const ProjectFileActions({
    required this.context,
    required this.ref,
    required this.scope,
    this.onOpenFile,
  });

  final BuildContext context;
  final WidgetRef ref;
  final ProjectFilesScope scope;
  final ValueChanged<String>? onOpenFile;

  ProjectFilesController get _controller =>
      ref.read(projectFilesControllerProvider(scope).notifier);

  Future<void> showEntryMenu(String path, ProjectFileEntry entry) {
    return showAppOptionBottomSheet<void>(
      context: context,
      builder: (sheetContext) {
        void run(Future<void> Function() action) {
          Navigator.of(sheetContext).pop();
          unawaited(action());
        }

        return AppOptionBottomSheet(
          handleKey: const Key('project-file-menu'),
          children: [
            _MenuHeader(path: path, entry: entry),
            if (entry.isDirectory) ...[
              _MenuTile(
                key: const Key('project-file-menu-upload'),
                icon: LucideIcons.upload,
                label: 'Upload files here',
                onTap: () => run(() => pickAndUpload(path)),
              ),
            ] else ...[
              if (onOpenFile != null)
                _MenuTile(
                  key: const Key('project-file-menu-open'),
                  icon: LucideIcons.eye,
                  label: 'Open',
                  onTap: () => run(() async => onOpenFile!(path)),
                ),
              _MenuTile(
                key: const Key('project-file-menu-download'),
                icon: LucideIcons.download,
                label: 'Download',
                onTap: () => run(() => download(path)),
              ),
            ],
            if (path.contains('/'))
              _MenuTile(
                key: const Key('project-file-menu-move-root'),
                icon: LucideIcons.cornerLeftUp,
                label: 'Move to project root',
                onTap: () => run(() => move(path, '')),
              ),
            _MenuTile(
              key: const Key('project-file-menu-copy-path'),
              icon: LucideIcons.copy,
              label: 'Copy path',
              onTap: () => run(() async {
                await Clipboard.setData(ClipboardData(text: path));
                _toast('Path copied');
              }),
            ),
            const _MenuHint(),
          ],
        );
      },
    );
  }

  Future<void> pickAndUpload(String parent) async {
    final List<PlatformFile> picked;
    try {
      picked = await FilePicker.pickFiles();
    } catch (_) {
      _toast('Files could not be selected.', error: true);
      return;
    }
    if (picked.isEmpty) return;
    final sources = <ProjectUploadSource>[];
    for (final file in picked) {
      sources.add(
        ProjectUploadSource(
          name: file.name,
          length: file.lengthSync() ?? await file.length(),
          open: file.readAsByteStream,
        ),
      );
    }
    final where = parent.isEmpty ? 'project root' : projectBaseName(parent);
    final result = await _controller.upload(parent, sources);
    if (result.failures.isEmpty) {
      HapticFeedback.lightImpact();
      _toast(
        result.uploaded == 1
            ? 'Uploaded ${sources.single.name} to $where'
            : 'Uploaded ${result.uploaded} files to $where',
      );
    } else {
      _toast(
        result.failures.length == 1
            ? result.failures.single
            : '${result.failures.length} uploads failed. '
                  '${result.failures.first}',
        error: true,
      );
    }
  }

  Future<void> download(String path) async {
    final name = projectBaseName(path);
    final messenger = ScaffoldMessenger.maybeOf(context);
    messenger
      ?..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          duration: const Duration(minutes: 5),
          content: Row(
            children: [
              const SizedBox.square(
                dimension: 14,
                child: CircularProgressIndicator(strokeWidth: 1.6),
              ),
              const SizedBox(width: 12),
              Expanded(child: Text('Downloading $name…')),
            ],
          ),
        ),
      );
    try {
      final file = await ref
          .read(projectRepositoryProvider)
          .fetchFile(
            workspaceId: scope.workspaceId,
            peonId: scope.peonId,
            projectKey: scope.projectKey,
            path: path,
          );
      messenger?.hideCurrentSnackBar();
      final saved = await FilePicker.saveFile(
        fileName: name,
        bytes: file.bytes,
        mimeType:
            file.contentType?.split(';').first.trim() ??
            'application/octet-stream',
      );
      if (saved != null) {
        HapticFeedback.lightImpact();
        _toast('Saved $name');
      }
    } on ProjectsException catch (error) {
      _toast(error.message, error: true);
    } catch (_) {
      _toast('$name could not be saved.', error: true);
    }
  }

  Future<void> move(String source, String targetDir) async {
    final where = targetDir.isEmpty
        ? 'project root'
        : projectBaseName(targetDir);
    try {
      await _controller.move(source, targetDir);
      _toast('Moved ${projectBaseName(source)} to $where');
    } on ProjectsException catch (error) {
      _toast(error.message, error: true);
    }
  }

  void _toast(String message, {bool error = false}) {
    if (!context.mounted) return;
    final colors = Theme.of(context).colorScheme;
    ScaffoldMessenger.maybeOf(context)
      ?..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          behavior: SnackBarBehavior.floating,
          content: Row(
            children: [
              Icon(
                error ? LucideIcons.circleAlert : LucideIcons.circleCheck,
                size: 16,
                color: error ? colors.error : colors.primary,
              ),
              const SizedBox(width: 10),
              Expanded(child: Text(message)),
            ],
          ),
        ),
      );
  }
}

class _MenuHeader extends StatelessWidget {
  const _MenuHeader({required this.path, required this.entry});

  final String path;
  final ProjectFileEntry entry;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final parent = projectParentPath(path);
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 0, 4, 14),
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: colors.primary.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(
              entry.isDirectory ? LucideIcons.folder : LucideIcons.file,
              size: 19,
              color: colors.primary,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  entry.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppTypography.display(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: colors.onSurface,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  [
                    parent.isEmpty ? '/' : '/$parent',
                    if (!entry.isDirectory && entry.size != null)
                      _size(entry.size!),
                  ].join('  ·  '),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppTypography.mono(
                    fontSize: 10.5,
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _MenuTile extends StatelessWidget {
  const _MenuTile({
    super.key,
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return AppOptionSheetTile(
      onTap: onTap,
      child: Row(
        children: [
          Icon(icon, size: 18, color: colors.primary),
          const SizedBox(width: 14),
          Expanded(
            child: Text(
              label,
              style: AppTypography.body(
                fontSize: 14,
                fontWeight: FontWeight.w500,
                color: colors.onSurface,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _MenuHint extends StatelessWidget {
  const _MenuHint();

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 4, 4, 0),
      child: Row(
        children: [
          Icon(LucideIcons.move, size: 13, color: colors.onSurfaceVariant),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              'Tip: long-press and drag to move into another folder.',
              style: AppTypography.body(
                fontSize: 12,
                color: colors.onSurfaceVariant,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

String _size(int size) {
  if (size < 1024) return '$size B';
  if (size < 1024 * 1024) return '${(size / 1024).round()} KB';
  return '${(size / (1024 * 1024)).toStringAsFixed(1)} MB';
}
