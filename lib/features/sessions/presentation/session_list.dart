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
import '../../../shared/formatters/activity_timestamp.dart';
import '../../../shared/layout/responsive_breakpoints.dart';
import '../../../shared/widgets/app_option_bottom_sheet.dart';
import '../../../shared/widgets/app_bottom_sheet.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_markdown.dart';
import '../../../shared/widgets/app_text_field.dart';
import '../../../shared/widgets/confirmation_bottom_sheet.dart';
import '../../../shared/widgets/loading_shimmer.dart';
import '../../../shared/widgets/presence_stack.dart';
import '../../../shared/widgets/sidebar_status_edge.dart';
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
            .take(value.visibleCount)
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
                onRename: (session, title) => ref
                    .read(sessionRepositoryProvider)
                    .renameSession(
                      workspaceId: session.workspaceId,
                      peonId: session.peonId,
                      sessionId: session.sessionId,
                      title: title,
                    ),
                onDelete: (session) => ref
                    .read(sessionRepositoryProvider)
                    .deleteSession(
                      workspaceId: session.workspaceId,
                      peonId: session.peonId,
                      sessionId: session.sessionId,
                    ),
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

/// Sliver-native session history for pages that share an outer scroll view.
///
/// Unlike [SessionList], this surface lazily builds only rows near the
/// viewport. Keep it inside a [CustomScrollView] so large cached histories do
/// not turn into one eager widget tree.
class SessionSliverList extends ConsumerWidget {
  const SessionSliverList({
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
        final canonicalId = projectId?.trim();
        final key = projectKey?.trim();
        final projectFiltered =
            canonicalId?.isNotEmpty == true || key?.isNotEmpty == true;
        final visibleSessions = value.sessions
            .where((session) {
              if (!projectFiltered) return true;
              if (canonicalId?.isNotEmpty == true &&
                  session.projectId == canonicalId) {
                return true;
              }
              return key?.isNotEmpty == true && session.projectKey == key;
            })
            .take(value.visibleCount)
            .toList(growable: false);
        return SliverMainAxisGroup(
          slivers: [
            if (value.catalogStale)
              const SliverToBoxAdapter(
                child: _SessionsNotice(
                  icon: LucideIcons.cloudOff,
                  message: 'The peon session catalog may be stale.',
                ),
              ),
            if (value.message case final message?)
              SliverToBoxAdapter(
                child: _SessionsNotice(
                  icon: LucideIcons.triangleAlert,
                  message: message,
                  actionLabel: 'Retry',
                  onAction: ref
                      .read(sessionsControllerProvider(scope).notifier)
                      .refresh,
                ),
              ),
            if (visibleSessions.isEmpty && value.isRefreshing)
              const SliverToBoxAdapter(child: _SessionListLoading())
            else if (visibleSessions.isEmpty)
              SliverToBoxAdapter(
                child: _SessionListEmptyState(
                  icon: LucideIcons.messageSquare,
                  title: projectFiltered
                      ? 'No project sessions yet'
                      : 'No sessions yet',
                  message: projectFiltered
                      ? 'Start a session to work in this project.'
                      : 'Start a session to work with this peon.',
                ),
              )
            else
              _LazySessionSliver(
                sessions: visibleSessions,
                selectedSessionId: selectedSessionId,
                onSessionSelected: onSessionSelected,
                activeSessions: activeSessions,
                presence: presence,
                onRename: (session, title) => ref
                    .read(sessionRepositoryProvider)
                    .renameSession(
                      workspaceId: session.workspaceId,
                      peonId: session.peonId,
                      sessionId: session.sessionId,
                      title: title,
                    ),
                onDelete: (session) => ref
                    .read(sessionRepositoryProvider)
                    .deleteSession(
                      workspaceId: session.workspaceId,
                      peonId: session.peonId,
                      sessionId: session.sessionId,
                    ),
              ),
            if (value.hasMore)
              SliverToBoxAdapter(
                child: _InfiniteSessionLoader(
                  enabled: !value.isLoadingMore && value.message == null,
                  loading: value.isLoadingMore,
                  onLoadMore: ref
                      .read(sessionsControllerProvider(scope).notifier)
                      .loadMore,
                ),
              ),
          ],
        );
      },
      loading: () => const SliverToBoxAdapter(child: _SessionListLoading()),
      error: (_, _) => SliverToBoxAdapter(
        child: _SessionsNotice(
          icon: LucideIcons.triangleAlert,
          message: 'Could not open the session cache.',
          actionLabel: 'Retry',
          onAction: () => ref.invalidate(sessionsControllerProvider(scope)),
        ),
      ),
    );
  }
}

class _InfiniteSessionLoader extends StatefulWidget {
  const _InfiniteSessionLoader({
    required this.enabled,
    required this.loading,
    required this.onLoadMore,
  });

  final bool enabled;
  final bool loading;
  final VoidCallback onLoadMore;

  @override
  State<_InfiniteSessionLoader> createState() => _InfiniteSessionLoaderState();
}

class _InfiniteSessionLoaderState extends State<_InfiniteSessionLoader> {
  static const _prefetchExtent = 480.0;

  ScrollPosition? _position;
  bool _loadScheduled = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _attachTo(Scrollable.maybeOf(context)?.position);
    _checkAfterLayout();
  }

  @override
  void didUpdateWidget(covariant _InfiniteSessionLoader oldWidget) {
    super.didUpdateWidget(oldWidget);
    _checkAfterLayout();
  }

  @override
  void dispose() {
    _position?.removeListener(_checkPosition);
    super.dispose();
  }

  void _attachTo(ScrollPosition? next) {
    if (identical(_position, next)) return;
    _position?.removeListener(_checkPosition);
    _position = next;
    _position?.addListener(_checkPosition);
  }

  void _checkAfterLayout() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _checkPosition();
    });
  }

  void _checkPosition() {
    final position = _position;
    if (!widget.enabled ||
        _loadScheduled ||
        position == null ||
        !position.hasContentDimensions ||
        position.extentAfter > _prefetchExtent) {
      return;
    }
    _loadScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _loadScheduled = false;
      if (mounted && widget.enabled) widget.onLoadMore();
    });
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      key: const Key('sessions-infinite-loader'),
      height: 48,
      child: Center(
        child: widget.loading
            ? const SizedBox.square(
                dimension: 14,
                child: CircularProgressIndicator(strokeWidth: 1.5),
              )
            : const SizedBox.shrink(),
      ),
    );
  }
}

class _LazySessionSliver extends StatefulWidget {
  const _LazySessionSliver({
    required this.sessions,
    required this.selectedSessionId,
    required this.onSessionSelected,
    required this.activeSessions,
    required this.presence,
    required this.onRename,
    required this.onDelete,
  });

  final List<SessionSummary> sessions;
  final String? selectedSessionId;
  final ValueChanged<SessionSummary>? onSessionSelected;
  final ActiveWorkspaceSessions? activeSessions;
  final PresenceState presence;
  final Future<void> Function(SessionSummary session, String? title) onRename;
  final Future<void> Function(SessionSummary session) onDelete;

  @override
  State<_LazySessionSliver> createState() => _LazySessionSliverState();
}

class _LazySessionSliverState extends State<_LazySessionSliver> {
  late Map<String, int> _indices;
  late Map<String, String> _fingerprints;
  Map<String, int> _moveDeltas = const {};
  Map<String, int> _flashRevisions = const {};
  int _moveRevision = 0;

  @override
  void initState() {
    super.initState();
    _indices = _sessionIndices(widget.sessions);
    _fingerprints = _sessionFingerprints(widget.sessions);
  }

  @override
  void didUpdateWidget(covariant _LazySessionSliver oldWidget) {
    super.didUpdateWidget(oldWidget);
    final nextIndices = _sessionIndices(widget.sessions);
    final nextFingerprints = _sessionFingerprints(widget.sessions);
    final nextMoves = <String, int>{};
    final nextFlashes = Map<String, int>.from(_flashRevisions);
    for (final entry in nextIndices.entries) {
      final oldIndex = _indices[entry.key];
      if (oldIndex != null && oldIndex != entry.value) {
        nextMoves[entry.key] = oldIndex - entry.value;
      }
      if (_fingerprints[entry.key] != nextFingerprints[entry.key]) {
        nextFlashes[entry.key] = (nextFlashes[entry.key] ?? 0) + 1;
      }
    }
    nextFlashes.removeWhere((key, _) => !nextIndices.containsKey(key));
    _indices = nextIndices;
    _fingerprints = nextFingerprints;
    _moveDeltas = nextMoves;
    _flashRevisions = nextFlashes;
    if (nextMoves.isNotEmpty) _moveRevision++;
  }

  @override
  Widget build(BuildContext context) {
    final rowExtent = _sessionRowExtent(context);
    final reduceMotion =
        MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    return SliverPadding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      sliver: SliverFixedExtentList.builder(
        itemExtent: rowExtent,
        itemCount: widget.sessions.length,
        findChildIndexCallback: (key) {
          if (key case ValueKey<String>(value: final sessionId)) {
            return _indices[sessionId];
          }
          return null;
        },
        itemBuilder: (context, index) {
          final session = widget.sessions[index];
          return _LazyReorderingSessionRow(
            key: ValueKey(session.sessionId),
            delta: _moveDeltas[session.sessionId] ?? 0,
            revision: _moveRevision,
            rowExtent: rowExtent,
            reduceMotion: reduceMotion,
            child: Semantics(
              sortKey: OrdinalSortKey(index.toDouble()),
              selected: session.sessionId == widget.selectedSessionId,
              child: _SessionRow(
                key: Key('session-${session.sessionId}'),
                session: session,
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
                flashRevision: _flashRevisions[session.sessionId] ?? 0,
                onRename: widget.onRename,
                onDelete: widget.onDelete,
              ),
            ),
          );
        },
      ),
    );
  }

  Map<String, int> _sessionIndices(List<SessionSummary> sessions) => {
    for (final (index, session) in sessions.indexed) session.sessionId: index,
  };

  Map<String, String> _sessionFingerprints(List<SessionSummary> sessions) => {
    for (final session in sessions)
      session.sessionId: [
        session.status ?? '',
        session.lastActivityAt ?? 0,
        session.preview ?? '',
        session.title ?? '',
        session.attentionUnread ? 'unread' : '',
      ].join('|'),
  };
}

class _LazyReorderingSessionRow extends StatefulWidget {
  const _LazyReorderingSessionRow({
    super.key,
    required this.delta,
    required this.revision,
    required this.rowExtent,
    required this.reduceMotion,
    required this.child,
  });

  final int delta;
  final int revision;
  final double rowExtent;
  final bool reduceMotion;
  final Widget child;

  @override
  State<_LazyReorderingSessionRow> createState() =>
      _LazyReorderingSessionRowState();
}

class _LazyReorderingSessionRowState extends State<_LazyReorderingSessionRow>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 240),
    value: 1,
  );

  @override
  void didUpdateWidget(covariant _LazyReorderingSessionRow oldWidget) {
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
      child: widget.child,
      builder: (context, child) {
        final progress = Curves.easeOutCubic.transform(_controller.value);
        return Transform.translate(
          key: Key(
            'session-flight-position-'
            '${(widget.key! as ValueKey<String>).value}',
          ),
          offset: Offset(0, widget.delta * widget.rowExtent * (1 - progress)),
          child: child,
        );
      },
    );
  }
}

double _sessionRowExtent(BuildContext context) {
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
    AppTypography.display(fontSize: 12.8, fontWeight: FontWeight.w500),
  );
  final detailHeight = [
    AppTypography.body(fontSize: 9.6),
    AppTypography.body(fontSize: 9.6),
  ].map(lineHeight).reduce((height, candidate) => math.max(height, candidate));
  return math.max(48, 12 + math.max(20, titleHeight) + 2 + detailHeight);
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
      height: 48,
      child: Stack(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 6, 8, 6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ShimmerBlock(width: titleWidth, height: 13),
                const SizedBox(height: 7),
                ShimmerBlock(width: detailWidth, height: 9),
              ],
            ),
          ),
          const Positioned(
            top: 4,
            bottom: 4,
            left: 0,
            child: ShimmerBlock(width: 2, height: 40),
          ),
        ],
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
    required this.onRename,
    required this.onDelete,
  });

  final List<SessionSummary> sessions;
  final String? selectedSessionId;
  final ValueChanged<SessionSummary>? onSessionSelected;
  final ActiveWorkspaceSessions? activeSessions;
  final PresenceState presence;
  final Future<void> Function(SessionSummary session, String? title) onRename;
  final Future<void> Function(SessionSummary session) onDelete;

  @override
  State<_AnimatedSessionList> createState() => _AnimatedSessionListState();
}

class _AnimatedSessionListState extends State<_AnimatedSessionList> {
  late Map<String, String> _fingerprints;
  Map<String, int> _flashRevisions = const {};

  @override
  void initState() {
    super.initState();
    _fingerprints = _sessionFingerprints(widget.sessions);
  }

  @override
  void didUpdateWidget(covariant _AnimatedSessionList oldWidget) {
    super.didUpdateWidget(oldWidget);
    final nextFingerprints = _sessionFingerprints(widget.sessions);
    final nextFlashes = Map<String, int>.from(_flashRevisions);
    for (final entry in nextFingerprints.entries) {
      if (_fingerprints[entry.key] == entry.value) continue;
      nextFlashes[entry.key] = (nextFlashes[entry.key] ?? 0) + 1;
    }
    nextFlashes.removeWhere((key, _) => !nextFingerprints.containsKey(key));
    _fingerprints = nextFingerprints;
    _flashRevisions = nextFlashes;
  }

  @override
  Widget build(BuildContext context) {
    final reduceMotion =
        MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    final rowExtent = _rowExtent(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: SizedBox(
        height: widget.sessions.length * rowExtent,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            for (final (index, session) in widget.sessions.indexed)
              _FlyingSessionPosition(
                key: ValueKey(session.sessionId),
                debugId: session.sessionId,
                top: index * rowExtent,
                rowExtent: rowExtent,
                reduceMotion: reduceMotion,
                child: Semantics(
                  sortKey: OrdinalSortKey(index.toDouble()),
                  selected: session.sessionId == widget.selectedSessionId,
                  child: _SessionRow(
                    key: Key('session-${session.sessionId}'),
                    session: session,
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
                    flashRevision: _flashRevisions[session.sessionId] ?? 0,
                    onRename: widget.onRename,
                    onDelete: widget.onDelete,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Map<String, String> _sessionFingerprints(List<SessionSummary> sessions) => {
    for (final session in sessions)
      session.sessionId: [
        session.status ?? '',
        session.lastActivityAt ?? 0,
        session.preview ?? '',
        session.title ?? '',
        session.attentionUnread ? 'unread' : '',
      ].join('|'),
  };

  double _rowExtent(BuildContext context) {
    final textScaler = MediaQuery.textScalerOf(context);
    final titleHeight = _lineHeight(
      AppTypography.display(fontSize: 12.8, fontWeight: FontWeight.w500),
      textScaler,
    );
    final detailHeight = [AppTypography.body(fontSize: 9.6)]
        .map((style) => _lineHeight(style, textScaler))
        .reduce((height, candidate) => height > candidate ? height : candidate);
    final rowHeight = 12 + math.max(20, titleHeight) + 2 + detailHeight;
    return math.max(48, rowHeight);
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
  static const _flightDuration = Duration(milliseconds: 240);
  static const _flightCurve = Cubic(0.22, 1, 0.36, 1);

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

class _SessionRow extends StatelessWidget {
  const _SessionRow({
    super.key,
    required this.session,
    required this.selected,
    required this.onSelected,
    required this.authoritativeRunning,
    required this.viewers,
    required this.flashRevision,
    required this.onRename,
    required this.onDelete,
  });

  final SessionSummary session;
  final bool selected;
  final ValueChanged<SessionSummary>? onSelected;
  final bool? authoritativeRunning;
  final List<PresenceViewer> viewers;
  final int flashRevision;
  final Future<void> Function(SessionSummary session, String? title) onRename;
  final Future<void> Function(SessionSummary session) onDelete;

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
              onLongPress: () async {
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
                      onRename: onRename,
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
                  await onDelete(session);
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
                          style: AppTypography.display(
                            fontSize: 12.8,
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
                const SizedBox(height: 2),
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
                            fontSize: 9.6,
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
                            fontSize: 9.6,
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
                          fontSize: 9.6,
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
    if (authoritativeRunning ?? session.status == 'running') {
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
