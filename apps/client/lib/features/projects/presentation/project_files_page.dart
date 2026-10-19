import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../shared/design/typography.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_navigation_bar.dart';
import '../application/project_files_controller.dart';
import '../domain/project_models.dart';
import 'project_file_actions.dart';
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
    final colors = Theme.of(context).colorScheme;
    void openFile(String path) => Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ProjectFileViewerPage(
          workspaceId: workspaceId,
          peonId: peonId,
          projectKey: key!,
          projectId: projectId,
          path: path,
        ),
      ),
    );
    final actions = scope == null
        ? null
        : ProjectFileActions(
            context: context,
            ref: ref,
            scope: scope,
            onOpenFile: openFile,
          );

    return Scaffold(
      key: const Key('project-files-page'),
      backgroundColor: Theme.of(context).scaffoldBackgroundColor,
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            AppNavigationBar(
              key: const Key('project-files-navbar'),
              showBackButton: true,
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
                        color: colors.secondary,
                        height: 1.2,
                      ),
                    ),
                ],
              ),
              right: scope == null
                  ? null
                  : Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        _UploadButton(
                          busy: state?.uploads.isNotEmpty == true,
                          onPressed: state == null
                              ? null
                              : () => actions!.pickAndUpload(''),
                        ),
                        const SizedBox(width: 4),
                        IconButton(
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
                              ? SizedBox.square(
                                  dimension: 16,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 1.5,
                                    color: colors.primary,
                                  ),
                                )
                              : Icon(
                                  LucideIcons.refreshCw,
                                  size: 17,
                                  color: colors.onSurfaceVariant,
                                ),
                        ),
                      ],
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
                        onOpenFile: openFile,
                        onEntryMenu: actions!.showEntryMenu,
                        onMove: actions.move,
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

/// What a long-press drag carries: the entry and where it lives.
class ProjectFileDragData {
  const ProjectFileDragData({required this.path, required this.entry});

  final String path;
  final ProjectFileEntry entry;
}

class ProjectFileTreeView extends StatefulWidget {
  const ProjectFileTreeView({
    super.key,
    required this.state,
    required this.onToggle,
    required this.onRetry,
    required this.onOpenFile,
    this.onEntryMenu,
    this.onMove,
    this.padding = const EdgeInsets.fromLTRB(8, 8, 8, 24),
  });

  final ProjectFilesState state;
  final ValueChanged<String> onToggle;
  final ValueChanged<String> onRetry;
  final ValueChanged<String>? onOpenFile;

  /// A long press released without dragging opens the entry's menu.
  final void Function(String path, ProjectFileEntry entry)? onEntryMenu;

  /// A long press dragged onto a folder (or the root zone) moves the entry.
  final void Function(String source, String targetDir)? onMove;
  final EdgeInsetsGeometry padding;

  @override
  State<ProjectFileTreeView> createState() => _ProjectFileTreeViewState();
}

class _ProjectFileTreeViewState extends State<ProjectFileTreeView> {
  static const _edge = 72.0;

  final _scroll = ScrollController();
  final _listKey = GlobalKey();
  ProjectFileDragData? _dragging;
  Timer? _autoScroll;
  double _scrollVelocity = 0;

  @override
  void dispose() {
    _autoScroll?.cancel();
    _scroll.dispose();
    super.dispose();
  }

  void _dragStarted(ProjectFileDragData data) {
    HapticFeedback.mediumImpact();
    setState(() => _dragging = data);
  }

  void _dragEnded() {
    _stopAutoScroll();
    if (mounted) setState(() => _dragging = null);
  }

  // Draggable never scrolls its list; nudge it while the finger rests near an
  // edge so a deep folder is reachable without letting go.
  void _dragMoved(Offset global) {
    final box = _listKey.currentContext?.findRenderObject() as RenderBox?;
    if (box == null || !box.hasSize) return;
    final local = box.globalToLocal(global);
    final height = box.size.height;
    if (local.dy < _edge) {
      _scrollVelocity = -((_edge - local.dy) / _edge) * 14;
    } else if (local.dy > height - _edge) {
      _scrollVelocity = ((local.dy - (height - _edge)) / _edge) * 14;
    } else {
      _scrollVelocity = 0;
    }
    if (_scrollVelocity == 0) {
      _stopAutoScroll();
    } else {
      _autoScroll ??= Timer.periodic(const Duration(milliseconds: 16), (_) {
        if (!_scroll.hasClients) return;
        final position = _scroll.position;
        final next = (position.pixels + _scrollVelocity).clamp(
          position.minScrollExtent,
          position.maxScrollExtent,
        );
        if (next != position.pixels) _scroll.jumpTo(next);
      });
    }
  }

  void _stopAutoScroll() {
    _autoScroll?.cancel();
    _autoScroll = null;
    _scrollVelocity = 0;
  }

  bool _canDropInto(ProjectFileDragData? data, String targetDir) =>
      data != null && projectMoveRefusal(data.path, targetDir) == null;

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    final root = state.directories[''];
    if (root == null || (root.loading && root.entries.isEmpty)) {
      return const _TreeLoading();
    }
    if (root.message != null) {
      return _FilesEmptyState(
        icon: LucideIcons.triangleAlert,
        title: 'Couldn’t load files',
        message: root.message!,
        action: AppButton(
          key: const Key('project-files-retry'),
          onPressed: () => widget.onRetry(''),
          variant: AppButtonVariant.secondary,
          size: AppButtonSize.sm,
          child: const Text('Retry'),
        ),
      );
    }
    final rootUploads = state.uploads.where((u) => u.parent.isEmpty);
    if (root.entries.isEmpty && rootUploads.isEmpty) {
      return const _FilesEmptyState(
        icon: LucideIcons.folder,
        title: 'Empty project',
        message: 'There are no files in this project yet.',
      );
    }

    final rows = <Widget>[];
    _appendDirectory(rows, '', 0);
    final list = ListView(
      key: const Key('project-file-tree'),
      controller: _scroll,
      padding: widget.padding,
      children: rows,
    );
    if (widget.onMove == null) return list;

    return Stack(
      key: _listKey,
      children: [
        Positioned.fill(child: list),
        Positioned(
          left: 12,
          right: 12,
          top: 8,
          child: IgnorePointer(
            ignoring: _dragging == null,
            child: AnimatedSlide(
              offset: _dragging == null ? const Offset(0, -1.4) : Offset.zero,
              duration: const Duration(milliseconds: 220),
              curve: Curves.easeOutCubic,
              child: AnimatedOpacity(
                opacity: _dragging == null ? 0 : 1,
                duration: const Duration(milliseconds: 180),
                child: _RootDropZone(
                  enabled: _canDropInto(_dragging, ''),
                  onAccept: (data) => widget.onMove!(data.path, ''),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  void _appendDirectory(List<Widget> rows, String path, int depth) {
    final state = widget.state;
    final directory = state.directories[path];
    if (directory == null) return;
    if (directory.loading && directory.entries.isEmpty) {
      rows.add(_DirectoryLoading(depth: depth));
      return;
    }
    if (directory.message case final message?) {
      rows.add(
        _DirectoryError(
          depth: depth,
          message: message,
          onRetry: () => widget.onRetry(path),
        ),
      );
      return;
    }
    final names = {for (final entry in directory.entries) entry.name};
    for (final upload in state.uploads) {
      if (upload.parent != path || names.contains(upload.name)) continue;
      rows.add(
        _UploadRow(
          key: ValueKey('project-upload-${upload.id}'),
          upload: upload,
          depth: depth,
        ),
      );
    }
    for (final entry in directory.entries) {
      final fullPath = path.isEmpty ? entry.name : '$path/${entry.name}';
      final open = entry.isDirectory && state.expanded.contains(fullPath);
      final upload = state.uploads
          .where((u) => u.parent == path && u.name == entry.name)
          .firstOrNull;
      Widget row = _FileTreeRow(
        key: ValueKey('project-file-$fullPath'),
        entry: entry,
        path: fullPath,
        depth: depth,
        open: open,
        busy: state.moving.contains(fullPath),
        upload: upload,
        onTap: entry.isDirectory ? () => widget.onToggle(fullPath) : null,
        onOpenFile: entry.isDirectory || widget.onOpenFile == null
            ? null
            : () => widget.onOpenFile!(fullPath),
      );
      if (widget.onMove != null && widget.onEntryMenu != null) {
        row = _DraggableEntry(
          key: ValueKey('project-drag-$fullPath'),
          data: ProjectFileDragData(path: fullPath, entry: entry),
          onStarted: _dragStarted,
          onMoved: _dragMoved,
          onEnded: _dragEnded,
          onMenu: () => widget.onEntryMenu!(fullPath, entry),
          child: row,
        );
      } else if (widget.onEntryMenu != null) {
        row = GestureDetector(
          onLongPress: () {
            HapticFeedback.mediumImpact();
            widget.onEntryMenu!(fullPath, entry);
          },
          child: row,
        );
      }
      if (entry.isDirectory && widget.onMove != null) {
        row = _FolderDropTarget(
          path: fullPath,
          open: open,
          canAccept: (data) => _canDropInto(data, fullPath),
          onHoverExpand: () => widget.onToggle(fullPath),
          onAccept: (data) => widget.onMove!(data.path, fullPath),
          child: row,
        );
      }
      rows.add(row);
      if (open) _appendDirectory(rows, fullPath, depth + 1);
    }
  }
}

/// Long press lifts the row; letting go without travelling opens its menu,
/// so one gesture serves both "what can I do with this" and "put it there".
class _DraggableEntry extends StatefulWidget {
  const _DraggableEntry({
    super.key,
    required this.data,
    required this.onStarted,
    required this.onMoved,
    required this.onEnded,
    required this.onMenu,
    required this.child,
  });

  final ProjectFileDragData data;
  final ValueChanged<ProjectFileDragData> onStarted;
  final ValueChanged<Offset> onMoved;
  final VoidCallback onEnded;
  final VoidCallback onMenu;
  final Widget child;

  @override
  State<_DraggableEntry> createState() => _DraggableEntryState();
}

class _DraggableEntryState extends State<_DraggableEntry> {
  static const _menuSlop = 14.0;
  double _travel = 0;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final entry = widget.data.entry;
    return LongPressDraggable<ProjectFileDragData>(
      data: widget.data,
      delay: const Duration(milliseconds: 350),
      hapticFeedbackOnStart: false,
      dragAnchorStrategy: pointerDragAnchorStrategy,
      onDragStarted: () {
        _travel = 0;
        widget.onStarted(widget.data);
      },
      onDragUpdate: (details) {
        _travel += details.delta.distance;
        widget.onMoved(details.globalPosition);
      },
      onDragEnd: (details) {
        widget.onEnded();
        if (!details.wasAccepted && _travel < _menuSlop) widget.onMenu();
      },
      feedback: Transform.translate(
        offset: const Offset(-24, -40),
        child: Material(
          color: Colors.transparent,
          child: Container(
            constraints: const BoxConstraints(maxWidth: 260),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
            decoration: BoxDecoration(
              color: colors.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: colors.primary.withValues(alpha: 0.5)),
              boxShadow: [
                BoxShadow(
                  color: colors.shadow.withValues(alpha: 0.32),
                  blurRadius: 18,
                  offset: const Offset(0, 8),
                ),
              ],
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  entry.isDirectory
                      ? LucideIcons.folder
                      : _fileIcon(entry.name),
                  size: 16,
                  color: entry.isDirectory
                      ? colors.primary
                      : colors.onSurfaceVariant,
                ),
                const SizedBox(width: 8),
                Flexible(
                  child: Text(
                    entry.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppTypography.mono(
                      fontSize: 12,
                      color: colors.onSurface,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
      childWhenDragging: Opacity(opacity: 0.35, child: widget.child),
      child: widget.child,
    );
  }
}

class _FolderDropTarget extends StatefulWidget {
  const _FolderDropTarget({
    required this.path,
    required this.open,
    required this.canAccept,
    required this.onHoverExpand,
    required this.onAccept,
    required this.child,
  });

  final String path;
  final bool open;
  final bool Function(ProjectFileDragData data) canAccept;
  final VoidCallback onHoverExpand;
  final ValueChanged<ProjectFileDragData> onAccept;
  final Widget child;

  @override
  State<_FolderDropTarget> createState() => _FolderDropTargetState();
}

class _FolderDropTargetState extends State<_FolderDropTarget> {
  Timer? _expand;

  @override
  void dispose() {
    _expand?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return DragTarget<ProjectFileDragData>(
      onWillAcceptWithDetails: (details) {
        final ok = widget.canAccept(details.data);
        if (ok) {
          HapticFeedback.selectionClick();
          // Resting on a closed folder opens it, like Finder's spring-loading.
          if (!widget.open) {
            _expand?.cancel();
            _expand = Timer(const Duration(milliseconds: 700), () {
              if (mounted && !widget.open) widget.onHoverExpand();
            });
          }
        }
        return ok;
      },
      onLeave: (_) => _expand?.cancel(),
      onAcceptWithDetails: (details) {
        _expand?.cancel();
        HapticFeedback.heavyImpact();
        widget.onAccept(details.data);
      },
      builder: (context, candidates, _) {
        final hovered = candidates.isNotEmpty;
        return AnimatedContainer(
          duration: const Duration(milliseconds: 140),
          curve: Curves.easeOut,
          decoration: BoxDecoration(
            color: hovered
                ? colors.primary.withValues(alpha: 0.14)
                : Colors.transparent,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(
              color: hovered ? colors.primary : Colors.transparent,
              width: 1.2,
            ),
          ),
          child: widget.child,
        );
      },
    );
  }
}

class _RootDropZone extends StatelessWidget {
  const _RootDropZone({required this.enabled, required this.onAccept});

  final bool enabled;
  final ValueChanged<ProjectFileDragData> onAccept;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return DragTarget<ProjectFileDragData>(
      key: const Key('project-files-root-drop'),
      onWillAcceptWithDetails: (_) {
        if (enabled) HapticFeedback.selectionClick();
        return enabled;
      },
      onAcceptWithDetails: (details) {
        HapticFeedback.heavyImpact();
        onAccept(details.data);
      },
      builder: (context, candidates, _) {
        final hovered = candidates.isNotEmpty;
        return AnimatedContainer(
          duration: const Duration(milliseconds: 140),
          height: 46,
          decoration: BoxDecoration(
            color: hovered
                ? colors.primary.withValues(alpha: 0.22)
                : colors.surfaceContainerHighest.withValues(alpha: 0.96),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: hovered
                  ? colors.primary
                  : colors.outlineVariant.withValues(alpha: enabled ? 1 : 0.4),
              width: hovered ? 1.5 : 1,
            ),
            boxShadow: [
              BoxShadow(
                color: colors.shadow.withValues(alpha: 0.18),
                blurRadius: 12,
                offset: const Offset(0, 4),
              ),
            ],
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(
                LucideIcons.cornerLeftUp,
                size: 15,
                color: enabled ? colors.primary : colors.onSurfaceVariant,
              ),
              const SizedBox(width: 8),
              Text(
                enabled
                    ? 'Drop here to move to project root'
                    : 'Already in project root',
                style: AppTypography.body(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w600,
                  color: enabled ? colors.onSurface : colors.onSurfaceVariant,
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _UploadRow extends StatelessWidget {
  const _UploadRow({super.key, required this.upload, required this.depth});

  final ProjectPendingUpload upload;
  final int depth;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return SizedBox(
      height: 34,
      child: Padding(
        padding: EdgeInsets.fromLTRB(8 + depth * 16, 0, 8, 0),
        child: Row(
          children: [
            const SizedBox(width: 18),
            _ProgressRing(progress: upload.progress),
            const SizedBox(width: 7),
            Expanded(
              child: Text(
                upload.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppTypography.mono(
                  fontSize: 12,
                  color: colors.onSurface.withValues(alpha: 0.7),
                ),
              ),
            ),
            Text(
              '${(upload.progress * 100).round()}%',
              style: AppTypography.mono(fontSize: 10, color: colors.primary),
            ),
          ],
        ),
      ),
    );
  }
}

class _ProgressRing extends StatelessWidget {
  const _ProgressRing({required this.progress});

  final double progress;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return SizedBox.square(
      dimension: 16,
      child: TweenAnimationBuilder<double>(
        tween: Tween(end: progress),
        duration: const Duration(milliseconds: 200),
        builder: (context, value, _) => CircularProgressIndicator(
          value: value == 0 ? null : value,
          strokeWidth: 2,
          color: colors.primary,
          backgroundColor: colors.outlineVariant,
        ),
      ),
    );
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
    this.busy = false,
    this.upload,
  });

  final ProjectFileEntry entry;
  final String path;
  final int depth;
  final bool open;
  final VoidCallback? onTap;
  final VoidCallback? onOpenFile;
  final bool busy;
  final ProjectPendingUpload? upload;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
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
                    child: Icon(
                      LucideIcons.chevronRight,
                      size: 13,
                      color: colors.onSurfaceVariant,
                    ),
                  )
                : null,
          ),
          if (upload != null)
            _ProgressRing(progress: upload!.progress)
          else if (busy)
            SizedBox.square(
              dimension: 16,
              child: CircularProgressIndicator(
                strokeWidth: 1.5,
                color: colors.primary,
              ),
            )
          else
            Icon(
              entry.isDirectory
                  ? (open ? LucideIcons.folderOpen : LucideIcons.folder)
                  : _fileIcon(entry.name),
              size: 16,
              color: entry.isDirectory
                  ? colors.primary
                  : colors.onSurfaceVariant,
            ),
          const SizedBox(width: 7),
          Expanded(
            child: Text(
              entry.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppTypography.mono(fontSize: 12, color: colors.onSurface),
            ),
          ),
          if (!entry.isDirectory && entry.size != null)
            Text(
              _formatFileSize(entry.size!),
              style: AppTypography.mono(
                fontSize: 10,
                color: colors.onSurfaceVariant,
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

class _UploadButton extends StatelessWidget {
  const _UploadButton({required this.busy, required this.onPressed});

  final bool busy;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Semantics(
      button: true,
      label: 'Upload files to project root',
      child: Material(
        color: colors.primary.withValues(alpha: 0.12),
        shape: const StadiumBorder(),
        child: InkWell(
          key: const Key('project-files-upload'),
          customBorder: const StadiumBorder(),
          onTap: onPressed,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                AnimatedSwitcher(
                  duration: const Duration(milliseconds: 180),
                  child: busy
                      ? SizedBox.square(
                          key: const ValueKey('busy'),
                          dimension: 14,
                          child: CircularProgressIndicator(
                            strokeWidth: 1.6,
                            color: colors.primary,
                          ),
                        )
                      : Icon(
                          LucideIcons.plus,
                          key: const ValueKey('idle'),
                          size: 15,
                          color: colors.primary,
                        ),
                ),
                const SizedBox(width: 5),
                Text(
                  'Upload',
                  style: AppTypography.body(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                    color: colors.primary,
                  ),
                ),
              ],
            ),
          ),
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
    final colors = Theme.of(context).colorScheme;
    return Padding(
      key: const Key('project-directory-loading'),
      padding: EdgeInsets.only(left: 34 + depth * 16),
      child: SizedBox(
        height: 34,
        child: Align(
          alignment: Alignment.centerLeft,
          child: SizedBox.square(
            dimension: 14,
            child: CircularProgressIndicator(
              strokeWidth: 1.5,
              color: colors.primary,
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
    final colors = Theme.of(context).colorScheme;
    return Padding(
      padding: EdgeInsets.fromLTRB(34 + depth * 16, 4, 8, 4),
      child: Row(
        children: [
          Icon(LucideIcons.triangleAlert, size: 14, color: colors.error),
          const SizedBox(width: 7),
          Expanded(
            child: Text(
              message,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: AppTypography.mono(fontSize: 10, color: colors.error),
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
    final colors = Theme.of(context).colorScheme;
    return ListView(
      key: const Key('project-files-loading'),
      padding: const EdgeInsets.all(16),
      children: List.generate(
        6,
        (index) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 9),
          child: Row(
            children: [
              SizedBox(
                width: 16,
                height: 16,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: colors.surfaceContainerHighest,
                    borderRadius: const BorderRadius.all(Radius.circular(3)),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: FractionallySizedBox(
                    widthFactor: 0.45 + (index % 3) * 0.12,
                    child: SizedBox(
                      height: 10,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: colors.outlineVariant,
                          borderRadius: const BorderRadius.all(
                            Radius.circular(8),
                          ),
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
    final colors = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 28, color: colors.onSurfaceVariant),
            const SizedBox(height: 12),
            Text(
              title,
              textAlign: TextAlign.center,
              style: AppTypography.display(
                fontSize: 15,
                fontWeight: FontWeight.w600,
                color: colors.onSurface,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              message,
              textAlign: TextAlign.center,
              style: AppTypography.body(
                fontSize: 13,
                color: colors.onSurfaceVariant,
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
