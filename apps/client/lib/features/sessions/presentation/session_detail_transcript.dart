part of 'session_detail_page.dart';

class _TranscriptBody extends StatefulWidget {
  const _TranscriptBody({
    required this.transcript,
    required this.workingLabel,
    required this.toolDisplayMode,
    required this.inquiries,
    required this.inquiryOnline,
    required this.onInquiryInstall,
    required this.onInquiryCancel,
    required this.ghost,
    required this.operator,
    required this.viewers,
    required this.composerHeight,
    required this.showWorking,
    required this.stopping,
    required this.stopError,
    required this.onStop,
    required this.onRefresh,
    required this.onLoadOlder,
    required this.onOpenAttachment,
    required this.onOpenPreview,
    required this.onOpenLink,
    required this.onSelectedText,
  });

  final AsyncValue<TranscriptState> transcript;
  final String workingLabel;
  final ToolDisplayMode toolDisplayMode;
  final PluginInquiryState inquiries;
  final bool inquiryOnline;
  final ValueChanged<PluginInstallInquiry> onInquiryInstall;
  final ValueChanged<PluginInstallInquiry> onInquiryCancel;
  final ComposerGhost? ghost;
  final OperatorIdentity? operator;
  final List<PresenceViewer> viewers;

  /// Listened to rather than passed by value: the composer resizes as the
  /// operator types, and only the list's own padding depends on it.
  final ValueListenable<double> composerHeight;
  final bool showWorking;
  final bool stopping;
  final String? stopError;
  final VoidCallback onStop;
  final Future<void> Function() onRefresh;
  final Future<void> Function() onLoadOlder;
  final ValueChanged<TranscriptAttachment> onOpenAttachment;
  final ValueChanged<TranscriptPreviewItem> onOpenPreview;
  final ValueChanged<String> onOpenLink;
  final ValueChanged<SelectedTextReply> onSelectedText;

  @override
  State<_TranscriptBody> createState() => _TranscriptBodyState();
}

class _TranscriptBodyState extends State<_TranscriptBody> {
  static const _bottomThreshold = 24.0;
  static const _historyThreshold = 400.0;

  final ScrollController _scrollController = ScrollController();
  final Map<String, GlobalKey> _replySourceKeys = {};
  var _requestingOlder = false;
  var _historyEdgeArmed = true;

  // Flattening walks every event and every content block, while this widget
  // rebuilds for reasons that have nothing to do with the transcript — a
  // keystroke in the composer is one. The event list is replaced whenever it
  // changes, so its identity is the whole cache key.
  List<TranscriptEvent>? _flattenedFrom;
  List<TranscriptItem> _flattened = const [];

  List<TranscriptItem> _items(List<TranscriptEvent> events) {
    if (identical(_flattenedFrom, events)) return _flattened;
    _flattenedFrom = events;
    return _flattened = flattenTranscriptEvents(events);
  }

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_loadOlderNearHistoryEdge);
  }

  void _loadOlderNearHistoryEdge() {
    if (_requestingOlder || !_scrollController.hasClients) return;
    final state = widget.transcript.value;
    if (state == null || !state.hasOlder || state.isLoadingOlder) return;
    final position = _scrollController.position;
    if (position.pixels < position.maxScrollExtent - _historyThreshold) {
      _historyEdgeArmed = true;
      return;
    }
    if (!_historyEdgeArmed) return;
    _historyEdgeArmed = false;
    _requestingOlder = true;
    widget.onLoadOlder().whenComplete(() {
      if (mounted) _requestingOlder = false;
    });
  }

  void _openReplySource(SelectedTextReply reply) {
    final context = _replySourceKeys[reply.eventId]?.currentContext;
    if (context == null) return;
    unawaited(
      Scrollable.ensureVisible(
        context,
        duration: const Duration(milliseconds: 260),
        curve: Curves.easeOut,
        alignment: 0.35,
      ),
    );
  }

  @override
  void didUpdateWidget(covariant _TranscriptBody oldWidget) {
    super.didUpdateWidget(oldWidget);
    final transcriptChanged =
        oldWidget.transcript.value != widget.transcript.value ||
        oldWidget.ghost != widget.ghost ||
        oldWidget.showWorking != widget.showWorking ||
        oldWidget.inquiries.inquiries != widget.inquiries.inquiries;
    if (!transcriptChanged || !_scrollController.hasClients) return;

    final position = _scrollController.position;
    final wasAtBottom =
        position.pixels <= position.minScrollExtent + _bottomThreshold;
    if (!wasAtBottom) return;

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scrollController.hasClients) return;
      _scrollController.jumpTo(_scrollController.position.minScrollExtent);
    });
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  Widget _workingContent(TranscriptEvent? latestEvent) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _TranscriptWorkingIndicator(
          activity: transcriptWorkingActivity(
            latestEvent,
            fallbackLabel: widget.workingLabel,
          ),
          stopping: widget.stopping,
          onStop: widget.onStop,
        ),
        if (widget.stopError case final error?)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              '⚠ $error',
              key: const Key('transcript-stop-error'),
              style: AppTypography.mono(fontSize: 10, color: colors.error),
            ),
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.transcript.value;
    final isLoading =
        widget.transcript.isLoading || (state?.isRefreshing ?? false);

    return Stack(
      fit: StackFit.expand,
      children: [
        widget.transcript.when(
          loading: () => const SizedBox.expand(),
          error: (_, _) => _TranscriptFailure(onRetry: widget.onRefresh),
          data: (state) {
            if (state.events.isEmpty && state.isRefreshing) {
              return const SizedBox.expand();
            }
            if (state.events.isEmpty &&
                !widget.showWorking &&
                widget.ghost == null &&
                widget.inquiries.inquiries.isEmpty &&
                !widget.inquiries.loading) {
              return _TranscriptEmpty(
                message: state.message,
                onRetry: widget.onRefresh,
              );
            }
            final items = _items(state.events);
            final hasTopControl = state.hasOlder || state.message != null;
            final hasWorking = widget.showWorking;
            final ghost = widget.ghost;
            final inquiryRows = widget.inquiries.inquiries.length;
            final workingGap = transcriptWorkingGap(
              items.lastOrNull,
              afterGhost: ghost != null,
            );
            // The list is reversed, so leading indices are the newest rows: the
            // working indicator sits below the ghost, which sits below the last
            // committed message.
            final leading =
                (hasWorking ? 1 : 0) + inquiryRows + (ghost != null ? 1 : 0);
            return ValueListenableBuilder<double>(
              valueListenable: widget.composerHeight,
              builder: (context, composerHeight, child) => ListView.builder(
                key: const Key('transcript-list'),
                controller: _scrollController,
                reverse: true,
                padding: EdgeInsets.fromLTRB(
                  16,
                  16,
                  12,
                  math.max(24, composerHeight + 4),
                ),
                itemCount: items.length + (hasTopControl ? 1 : 0) + leading,
                itemBuilder: (context, index) {
                  if (hasWorking && index == 0) {
                    return Padding(
                      key: ValueKey(
                        'transcript-working-flow-${state.events.lastOrNull?.eventId ?? 'empty'}',
                      ),
                      padding: EdgeInsets.only(top: workingGap),
                      child: _workingContent(state.events.lastOrNull),
                    );
                  }
                  final inquiryIndex = index - (hasWorking ? 1 : 0);
                  if (inquiryIndex >= 0 && inquiryIndex < inquiryRows) {
                    final inquiry = widget.inquiries.inquiries[inquiryIndex];
                    return Padding(
                      key: ValueKey('plugin-inquiry-${inquiry.inquiryId}'),
                      padding: const EdgeInsets.only(top: 16),
                      child: Center(
                        child: PluginInquiryCard(
                          inquiry: inquiry,
                          online: widget.inquiryOnline,
                          acting: widget.inquiries.acting.contains(
                            inquiry.inquiryId,
                          ),
                          onInstall: () => widget.onInquiryInstall(inquiry),
                          onCancel: () => widget.onInquiryCancel(inquiry),
                        ),
                      ),
                    );
                  }
                  if (ghost != null &&
                      index == (hasWorking ? 1 : 0) + inquiryRows) {
                    return _TranscriptGhost(
                      ghost: ghost,
                      operator: widget.operator,
                      topGap: items.isEmpty ? 0 : 16,
                    );
                  }
                  final dataIndex = index - leading;
                  if (dataIndex == items.length) {
                    return _TranscriptHistoryControl(
                      state: state,
                      onRetry: widget.onRefresh,
                      onLoadOlder: widget.onLoadOlder,
                    );
                  }
                  final chronologicalIndex = items.length - 1 - dataIndex;
                  final item = items[chronologicalIndex];
                  final previous = chronologicalIndex > 0
                      ? items[chronologicalIndex - 1]
                      : null;
                  final sourceEventId = switch (item) {
                    TranscriptUserItem(:final sourceEventId) => sourceEventId,
                    TranscriptTextItem(:final sourceEventId) => sourceEventId,
                    _ => null,
                  };
                  final child = Padding(
                    key: ValueKey(item.key),
                    padding: EdgeInsets.only(
                      top: transcriptItemGap(previous, item),
                    ),
                    child: TranscriptItemView(
                      item: item,
                      thinkingLabel: widget.workingLabel,
                      toolDisplayMode: widget.toolDisplayMode,
                      operator: widget.operator,
                      onOpenAttachment: widget.onOpenAttachment,
                      onOpenPreview: widget.onOpenPreview,
                      onOpenLink: widget.onOpenLink,
                      onSelectedText: widget.onSelectedText,
                      onOpenReplySource: _openReplySource,
                    ),
                  );
                  if (sourceEventId == null) return child;
                  final key = _replySourceKeys.putIfAbsent(
                    sourceEventId,
                    GlobalKey.new,
                  );
                  return KeyedSubtree(key: key, child: child);
                },
              ),
            );
          },
        ),
        Positioned(
          top: 8,
          left: 16,
          right: 16,
          child: _DelayedTranscriptLoadingPill(isLoading: isLoading),
        ),
        Positioned(
          top: 12,
          right: 14,
          child: PresenceStack(
            key: const Key('session-floating-presence'),
            size: PresenceStackSize.md,
            softShadow: true,
            viewers: [
              for (final viewer in widget.viewers)
                PresencePerson(
                  userId: viewer.userId,
                  displayName: viewer.displayName,
                  avatarUrl: viewer.avatarUrl,
                ),
            ],
          ),
        ),
      ],
    );
  }
}

class _TranscriptWorkingIndicator extends StatefulWidget {
  const _TranscriptWorkingIndicator({
    required this.activity,
    required this.stopping,
    required this.onStop,
  });

  final TranscriptWorkingActivity activity;
  final bool stopping;
  final VoidCallback onStop;

  @override
  State<_TranscriptWorkingIndicator> createState() =>
      _TranscriptWorkingIndicatorState();
}

class _TranscriptWorkingIndicatorState
    extends State<_TranscriptWorkingIndicator>
    with SingleTickerProviderStateMixin {
  late final AnimationController _dots = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1200),
  )..repeat();
  late DateTime _fallbackStartedAt = DateTime.now();
  late Timer _timer;
  DateTime _now = DateTime.now();

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() => _now = DateTime.now());
    });
  }

  @override
  void didUpdateWidget(covariant _TranscriptWorkingIndicator oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.activity.startedAt != widget.activity.startedAt ||
        oldWidget.activity.label != widget.activity.label) {
      _fallbackStartedAt = DateTime.now();
      _now = DateTime.now();
    }
  }

  @override
  void dispose() {
    _timer.cancel();
    _dots.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final startedAt = _workingStartedAt(widget.activity.startedAt);
    final duration = _formatWorkingDuration(_now.difference(startedAt));
    return Row(
      key: const Key('transcript-working'),
      children: [
        Flexible(
          child: Semantics(
            label: 'Agent working: ${widget.activity.label}',
            liveRegion: true,
            child: ExcludeSemantics(
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  AnimatedBuilder(
                    animation: _dots,
                    builder: (context, _) {
                      return Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          for (var index = 0; index < 3; index++) ...[
                            if (index > 0) const SizedBox(width: 3),
                            Opacity(
                              opacity:
                                  0.25 +
                                  0.75 *
                                      ((math.sin(
                                                (_dots.value * math.pi * 2) -
                                                    (index * 0.9),
                                              ) +
                                              1) /
                                          2),
                              child: DecoratedBox(
                                decoration: BoxDecoration(
                                  color: colors.primary,
                                  shape: BoxShape.circle,
                                ),
                                child: SizedBox.square(dimension: 4),
                              ),
                            ),
                          ],
                        ],
                      );
                    },
                  ),
                  const SizedBox(width: 8),
                  Flexible(
                    child: Text(
                      widget.activity.label,
                      key: const Key('transcript-working-label'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppTypography.mono(
                        fontSize: AppTypography.systemMessageFontSize,
                        color: colors.primary,
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    '· $duration',
                    key: const Key('transcript-working-duration'),
                    style: AppTypography.mono(
                      fontSize: AppTypography.systemMessageFontSize,
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(width: 4),
        TextButton.icon(
          key: const Key('transcript-stop'),
          onPressed: widget.stopping ? null : widget.onStop,
          style: TextButton.styleFrom(
            minimumSize: const Size(0, 36),
            padding: const EdgeInsets.symmetric(horizontal: 5),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            foregroundColor: colors.tertiary,
            disabledForegroundColor: colors.tertiary.withValues(alpha: 0.4),
            textStyle: AppTypography.mono(
              fontSize: AppTypography.systemMessageFontSize,
            ),
          ),
          icon: const Text('■', style: TextStyle(fontSize: 9, height: 1)),
          label: Text(widget.stopping ? 'Stopping…' : 'Stop'),
        ),
      ],
    );
  }

  DateTime _workingStartedAt(double? raw) {
    if (raw == null || raw <= 0) return _fallbackStartedAt;
    final milliseconds = raw < 100000000000
        ? (raw * 1000).round()
        : raw.round();
    final parsed = DateTime.fromMillisecondsSinceEpoch(milliseconds);
    if (parsed.isAfter(_now)) return _fallbackStartedAt;
    return parsed;
  }
}

String _formatWorkingDuration(Duration elapsed) {
  final totalSeconds = math.max(0, elapsed.inSeconds);
  final seconds = totalSeconds % 60;
  final totalMinutes = totalSeconds ~/ 60;
  if (totalMinutes < 60) {
    return '$totalMinutes:${seconds.toString().padLeft(2, '0')}';
  }
  final hours = totalMinutes ~/ 60;
  final minutes = totalMinutes % 60;
  return '$hours:${minutes.toString().padLeft(2, '0')}:'
      '${seconds.toString().padLeft(2, '0')}';
}

class _DelayedTranscriptLoadingPill extends StatefulWidget {
  const _DelayedTranscriptLoadingPill({required this.isLoading});

  static const delay = Duration(seconds: 2);

  final bool isLoading;

  @override
  State<_DelayedTranscriptLoadingPill> createState() =>
      _DelayedTranscriptLoadingPillState();
}

class _DelayedTranscriptLoadingPillState
    extends State<_DelayedTranscriptLoadingPill> {
  Timer? _showTimer;
  bool _isVisible = false;

  @override
  void initState() {
    super.initState();
    _syncVisibility();
  }

  @override
  void didUpdateWidget(_DelayedTranscriptLoadingPill oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.isLoading != widget.isLoading) {
      _syncVisibility();
    }
  }

  void _syncVisibility() {
    _showTimer?.cancel();
    if (!widget.isLoading) {
      if (_isVisible) {
        setState(() => _isVisible = false);
      }
      return;
    }
    _showTimer = Timer(_DelayedTranscriptLoadingPill.delay, () {
      if (mounted && widget.isLoading) {
        setState(() => _isVisible = true);
      }
    });
  }

  @override
  void dispose() {
    _showTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return IgnorePointer(
      child: AnimatedSlide(
        key: const Key('transcript-loading-slide'),
        offset: _isVisible ? Offset.zero : const Offset(0, -1.5),
        duration: _isVisible ? AppMotion.panelClose : AppMotion.base,
        curve: AppMotion.iosQuick,
        child: AnimatedOpacity(
          key: const Key('transcript-loading-opacity'),
          opacity: _isVisible ? 1 : 0,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeInOutCubic,
          child: Center(
            child: Semantics(
              container: true,
              liveRegion: true,
              label: _isVisible ? 'Loading messages' : null,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(999),
                child: BackdropFilter(
                  filter: ImageFilter.blur(sigmaX: 10, sigmaY: 10),
                  child: DecoratedBox(
                    key: const Key('transcript-loading-pill'),
                    decoration: BoxDecoration(
                      color: colors.surfaceContainerHighest.withValues(
                        alpha: 0.92,
                      ),
                      borderRadius: BorderRadius.circular(999),
                      border: Border.all(color: colors.outlineVariant),
                    ),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 6,
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          TickerMode(
                            enabled: _isVisible,
                            child: SizedBox.square(
                              dimension: 12,
                              child: CircularProgressIndicator(
                                strokeWidth: 1.5,
                                color: colors.onSurfaceVariant,
                              ),
                            ),
                          ),
                          const SizedBox(width: 6),
                          Text(
                            'Loading messages…',
                            style: AppTypography.body(
                              fontSize: 11,
                              fontWeight: FontWeight.w500,
                              color: colors.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _TranscriptHistoryControl extends StatelessWidget {
  const _TranscriptHistoryControl({
    required this.state,
    required this.onRetry,
    required this.onLoadOlder,
  });

  final TranscriptState state;
  final Future<void> Function() onRetry;
  final Future<void> Function() onLoadOlder;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (state.message case final message?)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(
              message,
              key: const Key('transcript-error'),
              textAlign: TextAlign.center,
              style: AppTypography.body(
                fontSize: 12,
                color: AppThemePalette.of(context).danger,
              ),
            ),
          ),
        AppButton(
          key: const Key('transcript-history-action'),
          onPressed: state.hasOlder ? onLoadOlder : onRetry,
          variant: AppButtonVariant.ghost,
          size: AppButtonSize.sm,
          loading: state.isLoadingOlder,
          child: Text(state.hasOlder ? 'Load older events' : 'Retry'),
        ),
      ],
    );
  }
}

/// The operator's own message, shown before Peon has committed it back. It
/// reuses the ordinary user bubble so the row it is replaced by looks the same,
/// and says it is not committed by being dimmed and breathing.
class _TranscriptGhost extends StatefulWidget {
  const _TranscriptGhost({
    required this.ghost,
    required this.operator,
    required this.topGap,
  });

  final ComposerGhost ghost;
  final OperatorIdentity? operator;
  final double topGap;

  @override
  State<_TranscriptGhost> createState() => _TranscriptGhostState();
}

class _TranscriptGhostState extends State<_TranscriptGhost>
    with SingleTickerProviderStateMixin {
  late final AnimationController _breath = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _breath.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final item = TranscriptUserItem(
      key: 'composer-ghost',
      text: widget.ghost.text,
      authorEmail: widget.operator?.email,
      authorGithubLogin: widget.operator?.githubLogin,
      authorAvatarUrl: widget.operator?.avatarUrl,
      attachments: [
        for (final attachment in widget.ghost.attachments)
          TranscriptAttachment(
            type: attachment.type,
            path: null,
            name: attachment.name,
            size: attachment.size,
          ),
      ],
      createdAt: widget.ghost.createdAt,
    );
    return Padding(
      key: const Key('transcript-ghost'),
      padding: EdgeInsets.only(top: widget.topGap),
      child: FadeTransition(
        opacity: Tween<double>(
          begin: 0.42,
          end: 0.68,
        ).animate(CurvedAnimation(parent: _breath, curve: Curves.easeInOut)),
        child: TranscriptItemView(item: item, operator: widget.operator),
      ),
    );
  }
}

class _TranscriptEmpty extends StatelessWidget {
  const _TranscriptEmpty({required this.message, required this.onRetry});

  final String? message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              message ?? 'No transcript yet.',
              key: const Key('transcript-empty'),
              textAlign: TextAlign.center,
              style: AppTypography.body(
                fontSize: 14,
                color: message == null
                    ? AppThemePalette.of(context).inkMuted
                    : AppThemePalette.of(context).danger,
              ),
            ),
            if (message != null) ...[
              const SizedBox(height: 12),
              AppButton(
                key: const Key('transcript-retry'),
                onPressed: onRetry,
                variant: AppButtonVariant.secondary,
                size: AppButtonSize.sm,
                child: const Text('Retry'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _TranscriptFailure extends StatelessWidget {
  const _TranscriptFailure({required this.onRetry});

  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return _TranscriptEmpty(
      message: 'Could not open the transcript cache.',
      onRetry: onRetry,
    );
  }
}
