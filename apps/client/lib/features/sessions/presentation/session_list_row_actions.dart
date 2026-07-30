part of 'session_list.dart';

/// Canonical compact work item used wherever a session appears in an index.
///
/// Activity defaults to off until the live active-session projection confirms
/// that this session is running.
class SessionWorkItem extends StatelessWidget {
  const SessionWorkItem({
    super.key,
    required this.session,
    this.selected = false,
    this.onSelected,
    this.authoritativeRunning = false,
    this.viewers = const [],
    this.flashRevision = 0,
    this.onRename,
    this.onDelete,
  });

  final SessionSummary session;
  final bool selected;
  final ValueChanged<SessionSummary>? onSelected;
  final bool authoritativeRunning;
  final List<PresenceViewer> viewers;
  final int flashRevision;
  final Future<void> Function(SessionSummary session, String? title)? onRename;
  final Future<void> Function(SessionSummary session)? onDelete;

  static double extentFor(BuildContext context) {
    final textScaler = MediaQuery.textScalerOf(context);
    double lineHeight(TextStyle style) {
      final painter = TextPainter(
        text: TextSpan(text: 'Ag', style: style),
        textDirection: TextDirection.ltr,
        textScaler: textScaler,
        maxLines: 1,
      )..layout();
      return painter.height;
    }

    final titleHeight = lineHeight(
      AppTypography.display(fontSize: 14, fontWeight: FontWeight.w500),
    );
    final detailHeight = lineHeight(AppTypography.body(fontSize: 10.6));
    return math.max(48, 12 + math.max(20, titleHeight) + detailHeight);
  }

  @override
  Widget build(BuildContext context) {
    final preview = session.displayPreview;
    final activity = formatActivityTimestamp(session.sortActivity) ?? '';
    Offset? pressPosition;
    final edge = _sessionEdgeStyle;
    return Stack(
      children: [
        Positioned.fill(
          child: Material(
            color: selected ? Theme.of(context).hoverColor : Colors.transparent,
            child: InkWell(
              onTap: onSelected == null ? null : () => onSelected!(session),
              onTapDown: (details) => pressPosition = details.globalPosition,
              onLongPress: onRename == null || onDelete == null
                  ? null
                  : () async {
                      await HapticFeedback.mediumImpact();
                      if (!context.mounted) return;
                      final action = await _showSessionContextMenu(
                        context,
                        pressPosition,
                      );
                      if (!context.mounted || action == null) {
                        return;
                      }
                      if (action == _SessionMenuAction.rename) {
                        await showAppBottomSheet<void>(
                          context: context,
                          builder: (_) => _RenameSessionSheet(
                            session: session,
                            onRename: onRename!,
                          ),
                        );
                        return;
                      }
                      final confirmed = await showAppConfirmationBottomSheet(
                        context: context,
                        title: 'Delete session?',
                        message:
                            'Delete “${session.displayTitle}” permanently? '
                            'This cannot be undone.',
                        confirmLabel: 'Delete session',
                        destructive: true,
                      );
                      if (!confirmed || !context.mounted) return;
                      try {
                        await onDelete!(session);
                      } on SessionsException catch (error) {
                        if (!context.mounted) return;
                        ScaffoldMessenger.of(
                          context,
                        ).showSnackBar(SnackBar(content: Text(error.message)));
                      } catch (_) {
                        if (!context.mounted) return;
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(
                            content: Text('Could not delete this session.'),
                          ),
                        );
                      }
                    },
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 6, 8, 6),
          child: IgnorePointer(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SizedBox(
                  height: 20,
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          session.displayTitle,
                          maxLines: 1,
                          overflow: TextOverflow.fade,
                          softWrap: false,
                          style: AppTypography.chatMessage(
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ),
                      PresenceStack(
                        key: Key('session-presence-${session.sessionId}'),
                        size: PresenceStackSize.xs,
                        viewers: [
                          for (final viewer in viewers)
                            PresencePerson(
                              userId: viewer.userId,
                              displayName: viewer.displayName,
                              avatarUrl: viewer.avatarUrl,
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
                Row(
                  children: [
                    if (session.projectKey?.trim().isNotEmpty == true) ...[
                      ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 140),
                        child: Text(
                          session.projectKey!,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: AppTypography.body(
                            fontSize: 10.6,
                            color: AppColors.forge.withValues(alpha: 0.8),
                          ),
                        ),
                      ),
                      const SizedBox(width: 7),
                    ],
                    if (preview != null)
                      Expanded(
                        child: AppMarkdownPreview(
                          key: Key('session-preview-${session.sessionId}'),
                          data: preview,
                          maxLines: 1,
                          overflow: TextOverflow.fade,
                          softWrap: false,
                          style: AppTypography.body(
                            fontSize: 10.6,
                            color: AppColors.boneFaint,
                          ),
                        ),
                      )
                    else
                      const Spacer(),
                    if (activity.isNotEmpty) ...[
                      const SizedBox(width: 7),
                      Text(
                        key: Key('session-activity-${session.sessionId}'),
                        activity,
                        style: AppTypography.body(
                          fontSize: 10.6,
                          color: AppColors.boneFaint,
                        ),
                      ),
                    ],
                  ],
                ),
              ],
            ),
          ),
        ),
        Positioned(
          key: Key('session-status-position-${session.sessionId}'),
          top: 4,
          bottom: 4,
          left: 0,
          child: SidebarStatusEdge(
            key: Key('session-status-${session.sessionId}'),
            style: edge.$1,
            semanticLabel: edge.$2,
            flashRevision: flashRevision,
          ),
        ),
      ],
    );
  }

  (SidebarStatusEdgeStyle, String) get _sessionEdgeStyle {
    if (authoritativeRunning) {
      return (SidebarStatusEdgeStyle.running, 'Running');
    }
    if (session.attentionUnread || session.status == 'needs_human') {
      return (
        SidebarStatusEdgeStyle.attention,
        session.attentionUnread
            ? 'Unread completed session'
            : 'Needs attention',
      );
    }
    if (session.status == 'failure' ||
        session.status == 'failed' ||
        session.status == 'error') {
      return (SidebarStatusEdgeStyle.failure, 'Failed');
    }
    return (SidebarStatusEdgeStyle.idle, 'Not running');
  }

  static Future<_SessionMenuAction?> _showSessionContextMenu(
    BuildContext context,
    Offset? pressPosition,
  ) async {
    final layoutSize = ResponsiveBreakpoints.sizeFor(
      MediaQuery.sizeOf(context).width,
    );
    if (layoutSize != ResponsiveLayoutSize.wide) {
      return showAppOptionBottomSheet<_SessionMenuAction>(
        context: context,
        builder: (context) => const _SessionActionsBottomSheet(),
      );
    }

    final overlay =
        Overlay.of(context).context.findRenderObject()! as RenderBox;
    final row = context.findRenderObject()! as RenderBox;
    final fallback = row.localToGlobal(
      Offset(row.size.width - 12, row.size.height / 2),
      ancestor: overlay,
    );
    final anchor = pressPosition ?? fallback;
    final x = anchor.dx.clamp(8.0, overlay.size.width - 8).toDouble();
    final y = anchor.dy.clamp(8.0, overlay.size.height - 8).toDouble();

    return showMenu<_SessionMenuAction>(
      context: context,
      useRootNavigator: true,
      color: AppColors.iron950,
      surfaceTintColor: Colors.transparent,
      elevation: 12,
      constraints: const BoxConstraints.tightFor(width: 160),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(8)),
        side: BorderSide(color: AppColors.iron800),
      ),
      position: RelativeRect.fromLTRB(
        x,
        y,
        overlay.size.width - x,
        overlay.size.height - y,
      ),
      items: [
        PopupMenuItem<_SessionMenuAction>(
          key: const Key('session-menu-rename'),
          value: _SessionMenuAction.rename,
          height: 40,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Row(
            children: [
              const Icon(
                LucideIcons.pencil,
                size: 13,
                color: AppColors.boneDim,
              ),
              const SizedBox(width: 8),
              Text(
                'Rename',
                style: AppTypography.body(
                  fontSize: 12,
                  color: AppColors.boneDim,
                ),
              ),
            ],
          ),
        ),
        PopupMenuItem<_SessionMenuAction>(
          key: const Key('session-menu-delete'),
          value: _SessionMenuAction.delete,
          height: 40,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Row(
            children: [
              const Icon(LucideIcons.trash2, size: 13, color: AppColors.blood),
              const SizedBox(width: 8),
              Text(
                'Delete',
                style: AppTypography.body(fontSize: 12, color: AppColors.blood),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

enum _SessionMenuAction { rename, delete }

class _RenameSessionSheet extends StatefulWidget {
  const _RenameSessionSheet({required this.session, required this.onRename});

  final SessionSummary session;
  final Future<void> Function(SessionSummary session, String? title) onRename;

  @override
  State<_RenameSessionSheet> createState() => _RenameSessionSheetState();
}

class _RenameSessionSheetState extends State<_RenameSessionSheet> {
  late final TextEditingController _controller = TextEditingController(
    text: widget.session.title ?? widget.session.promptPreview ?? '',
  );
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_saving) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final title = _controller.text.trim();
      await widget.onRename(widget.session, title.isEmpty ? null : title);
      if (mounted) Navigator.of(context).pop();
    } on SessionsException catch (error) {
      if (mounted) {
        setState(() {
          _saving = false;
          _error = error.message;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _saving = false;
          _error = 'Could not rename this session.';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return AppBottomSheet(
      title: 'Rename session',
      handleKey: const Key('session-rename-sheet-handle'),
      children: [
        AppTextField(
          key: const Key('session-rename-field'),
          controller: _controller,
          autofocus: true,
          label: 'Name',
          hint: 'Session name',
          errorText: _error,
          textCapitalization: TextCapitalization.sentences,
          onSubmitted: (_) => _save(),
        ),
        const SizedBox(height: 16),
        AppButton(
          key: const Key('session-rename-save'),
          fullWidth: true,
          loading: _saving,
          onPressed: _save,
          child: const Text('Save'),
        ),
      ],
    );
  }
}

class _SessionActionsBottomSheet extends StatelessWidget {
  const _SessionActionsBottomSheet();

  @override
  Widget build(BuildContext context) {
    return AppOptionBottomSheet(
      title: 'Session actions',
      handleKey: const Key('session-menu-sheet-handle'),
      children: [
        AppOptionSheetTile(
          key: const Key('session-menu-rename'),
          onTap: () => Navigator.of(context).pop(_SessionMenuAction.rename),
          child: Row(
            children: [
              const Icon(
                LucideIcons.pencil,
                size: 20,
                color: AppColors.boneDim,
              ),
              const SizedBox(width: 12),
              Text('Rename', style: AppTypography.optionLabel(selected: false)),
            ],
          ),
        ),
        AppOptionSheetTile(
          key: const Key('session-menu-delete'),
          onTap: () => Navigator.of(context).pop(_SessionMenuAction.delete),
          child: Row(
            children: [
              const Icon(LucideIcons.trash2, size: 20, color: AppColors.blood),
              const SizedBox(width: 12),
              Text(
                'Delete',
                style: AppTypography.optionLabel(
                  selected: false,
                ).copyWith(color: AppColors.blood),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
