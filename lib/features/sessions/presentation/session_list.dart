import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/live/active_sessions.dart';
import '../../../core/live/presence.dart';
import '../../../shared/design/colors.dart';
import '../../../shared/design/typography.dart';
import '../../../shared/layout/responsive_breakpoints.dart';
import '../../../shared/widgets/app_option_bottom_sheet.dart';
import '../../../shared/widgets/loading_shimmer.dart';
import '../../../shared/widgets/presence_stack.dart';
import '../application/sessions_controller.dart';
import '../domain/session_models.dart';

class SessionList extends ConsumerWidget {
  const SessionList({
    super.key,
    required this.workspaceId,
    required this.peonId,
    this.projectId,
    this.projectKey,
    this.selectedSessionId,
    this.onSessionSelected,
  });

  final String workspaceId;
  final String peonId;
  final String? projectId;
  final String? projectKey;
  final String? selectedSessionId;
  final ValueChanged<SessionSummary>? onSessionSelected;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scope = SessionsScope(workspaceId: workspaceId, peonId: peonId);
    final sessions = ref.watch(sessionsControllerProvider(scope));
    final activeSessions = ref.watch(
      activeSessionsProvider.select((state) => state.forWorkspace(workspaceId)),
    );
    final presence = ref.watch(presenceProvider);
    return sessions.when(
      skipLoadingOnRefresh: true,
      data: (value) {
        final projectFiltered =
            projectId?.trim().isNotEmpty == true ||
            projectKey?.trim().isNotEmpty == true;
        final filteredSessions = value.sessions
            .where((session) {
              if (!projectFiltered) return true;
              final canonicalId = projectId?.trim();
              if (canonicalId?.isNotEmpty == true &&
                  session.projectId == canonicalId) {
                return true;
              }
              final key = projectKey?.trim();
              return key?.isNotEmpty == true && session.projectKey == key;
            })
            .toList(growable: false);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (value.catalogStale)
              const _SessionsNotice(
                icon: LucideIcons.cloudOff,
                message: 'The peon session catalog may be stale.',
              ),
            if (value.message case final message?)
              _SessionsNotice(
                icon: LucideIcons.triangleAlert,
                message: message,
                actionLabel: 'Retry',
                onAction: ref
                    .read(sessionsControllerProvider(scope).notifier)
                    .refresh,
              ),
            if (filteredSessions.isEmpty && value.isRefreshing)
              const _SessionListLoading()
            else if (filteredSessions.isEmpty)
              _SessionListEmptyState(
                icon: LucideIcons.messageSquare,
                title: projectFiltered
                    ? 'No project sessions yet'
                    : 'No sessions yet',
                message: projectFiltered
                    ? 'Start a session to work in this project.'
                    : 'Start a session to work with this peon.',
              )
            else ...[
              _AnimatedSessionList(
                sessions: filteredSessions,
                selectedSessionId: selectedSessionId,
                onSessionSelected: onSessionSelected,
                activeSessions: activeSessions,
                presence: presence,
              ),
            ],
            if (value.hasMore)
              TextButton.icon(
                key: const Key('sessions-load-more'),
                onPressed: value.isLoadingMore
                    ? null
                    : ref
                          .read(sessionsControllerProvider(scope).notifier)
                          .loadMore,
                icon: value.isLoadingMore
                    ? const SizedBox.square(
                        dimension: 14,
                        child: CircularProgressIndicator(strokeWidth: 1.5),
                      )
                    : const Icon(LucideIcons.chevronsDown, size: 16),
                label: Text(
                  value.isLoadingMore ? 'Loading' : 'Load older sessions',
                ),
              ),
          ],
        );
      },
      loading: () => const _SessionListLoading(),
      error: (_, _) => _SessionsNotice(
        icon: LucideIcons.triangleAlert,
        message: 'Could not open the session cache.',
        actionLabel: 'Retry',
        onAction: () => ref.invalidate(sessionsControllerProvider(scope)),
      ),
    );
  }
}

class _SessionListLoading extends StatelessWidget {
  const _SessionListLoading();

  @override
  Widget build(BuildContext context) {
    return const LoadingShimmer(
      key: Key('sessions-loading-shimmer'),
      label: 'Loading sessions',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _SessionSkeletonRow(titleWidth: 178, detailWidth: 238),
          _SessionSkeletonRow(titleWidth: 224, detailWidth: 164),
          _SessionSkeletonRow(titleWidth: 146, detailWidth: 206),
          _SessionSkeletonRow(titleWidth: 196, detailWidth: 126),
        ],
      ),
    );
  }
}

class _SessionSkeletonRow extends StatelessWidget {
  const _SessionSkeletonRow({
    required this.titleWidth,
    required this.detailWidth,
  });

  final double titleWidth;
  final double detailWidth;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 54,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const ShimmerBlock(
                  width: 8,
                  height: 8,
                  borderRadius: BorderRadius.all(Radius.circular(999)),
                ),
                const SizedBox(width: 7),
                ShimmerBlock(width: titleWidth, height: 13),
              ],
            ),
            const SizedBox(height: 7),
            Padding(
              padding: const EdgeInsets.only(left: 15),
              child: ShimmerBlock(width: detailWidth, height: 9),
            ),
          ],
        ),
      ),
    );
  }
}

class _AnimatedSessionList extends StatefulWidget {
  const _AnimatedSessionList({
    required this.sessions,
    required this.selectedSessionId,
    required this.onSessionSelected,
    required this.activeSessions,
    required this.presence,
  });

  final List<SessionSummary> sessions;
  final String? selectedSessionId;
  final ValueChanged<SessionSummary>? onSessionSelected;
  final ActiveWorkspaceSessions? activeSessions;
  final PresenceState presence;

  @override
  State<_AnimatedSessionList> createState() => _AnimatedSessionListState();
}

class _AnimatedSessionListState extends State<_AnimatedSessionList> {
  late Map<String, int> _positions;
  Map<String, int> _shuffleDeltas = const {};
  int _shuffleRevision = 0;

  @override
  void initState() {
    super.initState();
    _positions = _indexSessions(widget.sessions);
  }

  @override
  void didUpdateWidget(covariant _AnimatedSessionList oldWidget) {
    super.didUpdateWidget(oldWidget);
    final nextPositions = _indexSessions(widget.sessions);
    final deltas = <String, int>{};
    for (final entry in nextPositions.entries) {
      final previousIndex = _positions[entry.key];
      if (previousIndex == null || previousIndex == entry.value) continue;
      deltas[entry.key] = previousIndex - entry.value;
    }
    _positions = nextPositions;
    if (deltas.isNotEmpty) {
      _shuffleDeltas = deltas;
      _shuffleRevision += 1;
    }
  }

  @override
  Widget build(BuildContext context) {
    final reduceMotion =
        MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    final rowExtent = _rowExtent(context);
    final rows = widget.sessions.indexed.toList()
      ..sort((a, b) {
        final aDelta = _shuffleDeltas[a.$2.sessionId] ?? 0;
        final bDelta = _shuffleDeltas[b.$2.sessionId] ?? 0;
        final aIsPromoted = aDelta > 0;
        final bIsPromoted = bDelta > 0;
        if (aIsPromoted != bIsPromoted) return aIsPromoted ? 1 : -1;
        return a.$1.compareTo(b.$1);
      });
    return SizedBox(
      height: widget.sessions.length * rowExtent,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          for (final (index, session) in rows)
            _FlyingSessionPosition(
              key: ValueKey(session.sessionId),
              debugId: session.sessionId,
              top: index * rowExtent,
              rowExtent: rowExtent,
              reduceMotion: reduceMotion,
              child: Padding(
                padding: const EdgeInsets.only(bottom: 2),
                child: Semantics(
                  sortKey: OrdinalSortKey(index.toDouble()),
                  selected: session.sessionId == widget.selectedSessionId,
                  child: _ShuffleSessionRow(
                    key: Key('session-shuffle-${session.sessionId}'),
                    session: session,
                    delta: _shuffleDeltas[session.sessionId] ?? 0,
                    revision: _shuffleRevision,
                    reduceMotion: reduceMotion,
                    selected: session.sessionId == widget.selectedSessionId,
                    onSelected: widget.onSessionSelected,
                    authoritativeRunning: widget.activeSessions?.contains(
                      peonId: session.peonId,
                      sessionId: session.sessionId,
                    ),
                    viewers: widget.presence.viewersForSession(
                      workspaceId: session.workspaceId,
                      peonId: session.peonId,
                      sessionId: session.sessionId,
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Map<String, int> _indexSessions(List<SessionSummary> sessions) => {
    for (final (index, session) in sessions.indexed) session.sessionId: index,
  };

  double _rowExtent(BuildContext context) {
    final textScaler = MediaQuery.textScalerOf(context);
    final titleHeight = _lineHeight(
      AppTypography.display(fontSize: 13, fontWeight: FontWeight.w500),
      textScaler,
    );
    final detailHeight =
        [AppTypography.body(fontSize: 10.5), AppTypography.mono(fontSize: 10.5)]
            .map((style) => _lineHeight(style, textScaler))
            .reduce(
              (height, candidate) => height > candidate ? height : candidate,
            );
    final rowHeight = 14 + titleHeight + 3 + detailHeight;
    // Isolated glyph metrics can round slightly below the line boxes used by
    // the nested Rows, especially with the Android font rasterizer. Keep four
    // pixels of layout slack, then the existing two-pixel gap between rows.
    return (rowHeight < 48 ? 48 : rowHeight) + 6;
  }

  double _lineHeight(TextStyle style, TextScaler textScaler) {
    final painter = TextPainter(
      text: TextSpan(text: 'Ag', style: style),
      textDirection: TextDirection.ltr,
      textScaler: textScaler,
      maxLines: 1,
    )..layout();
    return painter.height;
  }
}

class _FlyingSessionPosition extends StatefulWidget {
  const _FlyingSessionPosition({
    super.key,
    required this.debugId,
    required this.top,
    required this.rowExtent,
    required this.reduceMotion,
    required this.child,
  });

  final String debugId;
  final double top;
  final double rowExtent;
  final bool reduceMotion;
  final Widget child;

  @override
  State<_FlyingSessionPosition> createState() => _FlyingSessionPositionState();
}

class _FlyingSessionPositionState extends State<_FlyingSessionPosition>
    with SingleTickerProviderStateMixin {
  static const _flightDuration = Duration(milliseconds: 480);
  static const _flightCurve = Cubic(0.40, 0, 0.18, 1);

  late double _fromTop = widget.top;
  late double _toTop = widget.top;
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: _flightDuration,
    value: 1,
  );

  double get _currentTop {
    final progress = _flightCurve.transform(_controller.value);
    return _fromTop + ((_toTop - _fromTop) * progress);
  }

  @override
  void didUpdateWidget(covariant _FlyingSessionPosition oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.top == oldWidget.top) return;
    final currentTop = _currentTop;
    _fromTop = widget.reduceMotion ? widget.top : currentTop;
    _toTop = widget.top;
    if (widget.reduceMotion) {
      _controller.value = 1;
    } else {
      _controller.forward(from: 0);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Positioned(
      top: 0,
      left: 0,
      right: 0,
      height: widget.rowExtent,
      child: AnimatedBuilder(
        animation: _controller,
        child: widget.child,
        builder: (context, child) => Transform.translate(
          key: Key('session-flight-position-${widget.debugId}'),
          offset: Offset(0, _currentTop),
          child: child,
        ),
      ),
    );
  }
}

class _ShuffleSessionRow extends StatefulWidget {
  const _ShuffleSessionRow({
    super.key,
    required this.session,
    required this.delta,
    required this.revision,
    required this.reduceMotion,
    required this.selected,
    required this.onSelected,
    required this.authoritativeRunning,
    required this.viewers,
  });

  final SessionSummary session;
  final int delta;
  final int revision;
  final bool reduceMotion;
  final bool selected;
  final ValueChanged<SessionSummary>? onSelected;
  final bool? authoritativeRunning;
  final List<PresenceViewer> viewers;

  @override
  State<_ShuffleSessionRow> createState() => _ShuffleSessionRowState();
}

class _ShuffleSessionRowState extends State<_ShuffleSessionRow>
    with SingleTickerProviderStateMixin {
  static const _shuffleDuration = Duration(milliseconds: 400);

  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: _shuffleDuration,
    value: 1,
  );

  @override
  void didUpdateWidget(covariant _ShuffleSessionRow oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.revision == oldWidget.revision || widget.delta == 0) return;
    if (widget.reduceMotion) {
      _controller.value = 1;
    } else {
      _controller.forward(from: 0);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      child: _SessionRow(
        key: Key('session-${widget.session.sessionId}'),
        session: widget.session,
        selected: widget.selected,
        onSelected: widget.onSelected,
        authoritativeRunning: widget.authoritativeRunning,
        viewers: widget.viewers,
      ),
      builder: (context, child) {
        final progress = Curves.easeInOutCubicEmphasized.transform(
          _controller.value,
        );
        final lift = math.sin(progress * math.pi);
        final promoted = widget.delta > 0;
        final intensity = promoted ? 1.0 : 0.28;
        final scale = 1 + (0.035 * lift * intensity);
        final highlight = lift * intensity;

        return RepaintBoundary(
          child: Transform.scale(
            key: Key('session-shuffle-transform-${widget.session.sessionId}'),
            scale: scale,
            child: DecoratedBox(
              key: Key('session-shuffle-highlight-${widget.session.sessionId}'),
              decoration: BoxDecoration(
                color: AppColors.fel.withValues(alpha: 0.075 * highlight),
                borderRadius: const BorderRadius.all(Radius.circular(6)),
                border: Border.all(
                  color: AppColors.felBright.withValues(
                    alpha: 0.20 * highlight,
                  ),
                ),
                boxShadow: [
                  BoxShadow(
                    color: AppColors.voidColor.withValues(
                      alpha: 0.55 * highlight,
                    ),
                    blurRadius: 20 * highlight,
                    offset: Offset(0, 8 * highlight),
                  ),
                ],
              ),
              child: child,
            ),
          ),
        );
      },
    );
  }
}

class _SessionRow extends StatelessWidget {
  const _SessionRow({
    super.key,
    required this.session,
    required this.selected,
    required this.onSelected,
    required this.authoritativeRunning,
    required this.viewers,
  });

  final SessionSummary session;
  final bool selected;
  final ValueChanged<SessionSummary>? onSelected;
  final bool? authoritativeRunning;
  final List<PresenceViewer> viewers;

  @override
  Widget build(BuildContext context) {
    final preview = session.displayPreview;
    final activity = _activityLabel(session.sortActivity);
    Offset? pressPosition;
    return Material(
      color: selected ? Theme.of(context).hoverColor : Colors.transparent,
      borderRadius: const BorderRadius.all(Radius.circular(6)),
      child: InkWell(
        borderRadius: const BorderRadius.all(Radius.circular(6)),
        onTap: onSelected == null ? null : () => onSelected!(session),
        onTapDown: (details) => pressPosition = details.globalPosition,
        onLongPress: () async {
          await HapticFeedback.mediumImpact();
          if (!context.mounted) return;
          await _showSessionContextMenu(context, pressPosition);
        },
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    _SessionStatusLight(
                      key: Key('session-status-${session.sessionId}'),
                      status: session.status,
                      attentionUnread: session.attentionUnread,
                      authoritativeRunning: authoritativeRunning,
                    ),
                    const SizedBox(width: 7),
                    Expanded(
                      child: Text(
                        session.displayTitle,
                        maxLines: 1,
                        overflow: TextOverflow.fade,
                        softWrap: false,
                        style: AppTypography.display(
                          fontSize: 13,
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
                const SizedBox(height: 3),
                Padding(
                  padding: const EdgeInsets.only(left: 15),
                  child: Row(
                    children: [
                      if (session.projectKey?.trim().isNotEmpty == true) ...[
                        ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 140),
                          child: Text(
                            session.projectKey!,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: AppTypography.mono(
                              fontSize: 10.5,
                              color: AppColors.forge.withValues(alpha: 0.8),
                            ),
                          ),
                        ),
                        const SizedBox(width: 7),
                      ],
                      if (preview != null)
                        Expanded(
                          child: Text(
                            preview,
                            maxLines: 1,
                            overflow: TextOverflow.fade,
                            softWrap: false,
                            style: AppTypography.body(
                              fontSize: 10.5,
                              color: AppColors.boneFaint,
                            ),
                          ),
                        )
                      else
                        const Spacer(),
                      if (activity.isNotEmpty) ...[
                        const SizedBox(width: 7),
                        Text(
                          activity,
                          style: AppTypography.mono(
                            fontSize: 10.5,
                            color: AppColors.boneFaint,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  static Future<void> _showSessionContextMenu(
    BuildContext context,
    Offset? pressPosition,
  ) async {
    final layoutSize = ResponsiveBreakpoints.sizeFor(
      MediaQuery.sizeOf(context).width,
    );
    if (layoutSize != ResponsiveLayoutSize.wide) {
      await showAppOptionBottomSheet<_SessionMenuAction>(
        context: context,
        builder: (context) => const _SessionActionsBottomSheet(),
      );
      return;
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

    await showMenu<_SessionMenuAction>(
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

  static String _activityLabel(double value) {
    if (value <= 0) return '';
    final elapsed = DateTime.now().millisecondsSinceEpoch - value.round();
    final seconds = elapsed < 0 ? 0 : elapsed ~/ 1000;
    if (seconds < 60) return '${seconds}s';
    final minutes = seconds ~/ 60;
    if (minutes < 60) return '${minutes}m';
    final hours = minutes ~/ 60;
    if (hours < 24) return '${hours}h';
    return '${hours ~/ 24}d';
  }
}

enum _SessionMenuAction { rename, delete }

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

class _SessionStatusLight extends StatelessWidget {
  const _SessionStatusLight({
    super.key,
    required this.status,
    required this.attentionUnread,
    required this.authoritativeRunning,
  });

  final String? status;
  final bool attentionUnread;
  final bool? authoritativeRunning;

  @override
  Widget build(BuildContext context) {
    final palette = _palette;
    return Semantics(
      label: _semanticLabel,
      child: ExcludeSemantics(
        child: Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(
            color: palette.color,
            shape: BoxShape.circle,
            boxShadow: palette.glowing
                ? [
                    BoxShadow(
                      color: palette.color.withValues(alpha: 0.95),
                      blurRadius: 4,
                    ),
                    BoxShadow(
                      color: palette.color.withValues(alpha: 0.72),
                      blurRadius: 11,
                    ),
                  ]
                : null,
          ),
        ),
      ),
    );
  }

  _SessionLightPalette get _palette {
    if (authoritativeRunning ?? status == 'running') {
      return const _SessionLightPalette(
        color: AppColors.felBright,
        glowing: true,
      );
    }
    if (attentionUnread || status == 'needs_human') {
      return const _SessionLightPalette(color: AppColors.forge, glowing: true);
    }
    if (status == 'failure' || status == 'failed' || status == 'error') {
      return const _SessionLightPalette(color: AppColors.blood, glowing: true);
    }
    return const _SessionLightPalette(color: AppColors.iron700, glowing: false);
  }

  String get _semanticLabel {
    if (authoritativeRunning ?? status == 'running') return 'Running';
    if (attentionUnread) return 'Unread completed session';
    if (status == 'needs_human') return 'Needs attention';
    if (status == 'failure' || status == 'failed' || status == 'error') {
      return 'Failed';
    }
    return 'Not running';
  }
}

class _SessionLightPalette {
  const _SessionLightPalette({required this.color, required this.glowing});

  final Color color;
  final bool glowing;
}

class _SessionsNotice extends StatelessWidget {
  const _SessionsNotice({
    required this.icon,
    required this.message,
    this.actionLabel,
    this.onAction,
  });

  final IconData icon;
  final String message;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(
        color: AppColors.forgeDeep.withValues(alpha: 0.16),
        borderRadius: const BorderRadius.all(Radius.circular(10)),
      ),
      child: Row(
        children: [
          Icon(icon, size: 16, color: AppColors.ember),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              message,
              style: AppTypography.body(fontSize: 12, color: AppColors.ember),
            ),
          ),
          if (actionLabel != null)
            TextButton(onPressed: onAction, child: Text(actionLabel!)),
        ],
      ),
    );
  }
}

class _SessionListEmptyState extends StatelessWidget {
  const _SessionListEmptyState({
    required this.icon,
    required this.title,
    required this.message,
  });

  final IconData icon;
  final String title;
  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: const BoxDecoration(
        color: AppColors.rowSurface,
        borderRadius: BorderRadius.all(Radius.circular(12)),
      ),
      child: Row(
        children: [
          Icon(icon, color: AppColors.boneFaint),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: AppTypography.body(fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 2),
                Text(
                  message,
                  style: AppTypography.body(
                    fontSize: 12,
                    color: AppColors.boneDim,
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
