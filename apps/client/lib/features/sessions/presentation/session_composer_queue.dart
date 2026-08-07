part of 'session_composer.dart';

class _QueuedFollowupList extends StatelessWidget {
  const _QueuedFollowupList({
    required this.items,
    required this.editing,
    required this.removing,
    required this.sending,
    required this.onEdit,
    required this.onRemove,
    required this.onSteer,
  });

  final List<QueuedFollowup> items;
  final Set<String> editing;
  final Set<String> removing;
  final Set<String> sending;
  final Future<void> Function(String itemId, String prompt)? onEdit;
  final Future<void> Function(String itemId)? onRemove;
  final Future<void> Function(String itemId)? onSteer;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Semantics(
      label: 'Queued follow-ups',
      container: true,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 224),
        child: ListView.separated(
          key: const Key('session-queue-list'),
          shrinkWrap: true,
          padding: EdgeInsets.zero,
          itemCount: items.length,
          separatorBuilder: (_, _) => const SizedBox(height: 8),
          itemBuilder: (context, index) {
            final item = items[index];
            final isEditing = editing.contains(item.id);
            final isRemoving = removing.contains(item.id);
            final isSending = sending.contains(item.id);
            final busy = isEditing || isRemoving || isSending;
            const shape = BorderRadius.only(
              topLeft: Radius.circular(12),
              topRight: Radius.circular(12),
              bottomLeft: Radius.circular(12),
              bottomRight: Radius.circular(3),
            );
            return ClipRRect(
              borderRadius: shape,
              child: BackdropFilter(
                filter: ImageFilter.blur(sigmaX: 10, sigmaY: 10),
                child: Material(
                  key: Key('session-queue-item-${item.id}'),
                  color: colors.primaryContainer.withValues(alpha: 0.72),
                  shape: RoundedRectangleBorder(
                    borderRadius: shape,
                    side: BorderSide(
                      color: colors.primary.withValues(alpha: 0.18),
                    ),
                  ),
                  child: InkWell(
                    key: Key('session-queue-open-${item.id}'),
                    onTap: busy
                        ? null
                        : () => _showQueuedFollowupDialog(
                            context,
                            item: item,
                            onEdit: onEdit,
                            onRemove: onRemove,
                            onSteer: onSteer,
                          ),
                    borderRadius: shape,
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Padding(
                            padding: const EdgeInsets.only(top: 3),
                            child: busy
                                ? SizedBox.square(
                                    dimension: 13,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 1.8,
                                      color: colors.onPrimaryContainer,
                                    ),
                                  )
                                : Icon(
                                    LucideIcons.hourglass,
                                    size: 13,
                                    color: colors.onPrimaryContainer.withValues(
                                      alpha: 0.72,
                                    ),
                                  ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                AppMarkdownPreview(
                                  key: Key('session-queue-markdown-${item.id}'),
                                  data: item.prompt,
                                  style: AppTypography.chatMessage(
                                    color: colors.onPrimaryContainer,
                                    height: 1.35,
                                  ),
                                  maxLines: 3,
                                  overflow: TextOverflow.ellipsis,
                                  softWrap: true,
                                ),
                                if (item.attachments.isNotEmpty) ...[
                                  const SizedBox(height: 4),
                                  Wrap(
                                    spacing: 8,
                                    runSpacing: 3,
                                    children: [
                                      for (final attachment in item.attachments)
                                        Text(
                                          '📎 ${attachment.label}',
                                          style: AppTypography.mono(
                                            fontSize: 10,
                                            color: colors.onPrimaryContainer
                                                .withValues(alpha: 0.7),
                                          ),
                                        ),
                                    ],
                                  ),
                                ],
                              ],
                            ),
                          ),
                          const SizedBox(width: 6),
                          Padding(
                            padding: const EdgeInsets.only(top: 2),
                            child: Icon(
                              LucideIcons.maximize2,
                              size: 14,
                              color: colors.onPrimaryContainer.withValues(
                                alpha: 0.72,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

Future<void> _showQueuedFollowupDialog(
  BuildContext context, {
  required QueuedFollowup item,
  required Future<void> Function(String itemId, String prompt)? onEdit,
  required Future<void> Function(String itemId)? onRemove,
  required Future<void> Function(String itemId)? onSteer,
}) {
  return showGeneralDialog<void>(
    context: context,
    barrierDismissible: true,
    barrierLabel: 'Close queued message',
    barrierColor: Theme.of(context).colorScheme.scrim.withValues(alpha: 0.52),
    transitionDuration: AppMotion.backdropFade,
    pageBuilder: (_, _, _) => _QueuedFollowupDialog(
      item: item,
      onEdit: onEdit,
      onRemove: onRemove,
      onSteer: onSteer,
    ),
    transitionBuilder: (_, animation, _, child) {
      final curved = CurvedAnimation(
        parent: animation,
        curve: AppMotion.modalSettle,
        reverseCurve: Curves.easeInCubic,
      );
      return FadeTransition(
        opacity: curved,
        child: ScaleTransition(
          scale: Tween<double>(begin: 0.94, end: 1).animate(curved),
          child: child,
        ),
      );
    },
  );
}

class _QueuedFollowupDialog extends StatefulWidget {
  const _QueuedFollowupDialog({
    required this.item,
    required this.onEdit,
    required this.onRemove,
    required this.onSteer,
  });

  final QueuedFollowup item;
  final Future<void> Function(String itemId, String prompt)? onEdit;
  final Future<void> Function(String itemId)? onRemove;
  final Future<void> Function(String itemId)? onSteer;

  @override
  State<_QueuedFollowupDialog> createState() => _QueuedFollowupDialogState();
}

class _QueuedFollowupDialogState extends State<_QueuedFollowupDialog> {
  late final TextEditingController _controller = TextEditingController(
    text: widget.item.prompt,
  );
  bool _editing = false;
  String? _busyAction;
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _run(String action, Future<void> Function() callback) async {
    setState(() {
      _busyAction = action;
      _error = null;
    });
    try {
      await callback();
      if (mounted) Navigator.of(context).pop();
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _busyAction = null;
        _error = 'The queued message could not be updated.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final palette = Theme.of(context).extension<AppThemePalette>()?.package;
    final height = MediaQuery.sizeOf(context).height * 0.8;
    final busy = _busyAction != null;
    return Dialog(
      backgroundColor: Colors.transparent,
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
      child: ConstrainedBox(
        key: const Key('session-queue-dialog'),
        constraints: BoxConstraints(maxWidth: 560, maxHeight: height),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: palette?.surfaceRaised ?? colors.surfaceContainerHighest,
            border: Border.all(color: colors.outlineVariant),
            borderRadius: AppMotion.surfaceShape,
            boxShadow: [
              BoxShadow(
                color: colors.shadow.withValues(alpha: 0.24),
                blurRadius: 36,
                offset: const Offset(0, 18),
              ),
            ],
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 14, 8, 8),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        _editing ? 'Edit queued message' : 'Queued message',
                        style: AppTypography.display(
                          fontSize: 17,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                    IconButton(
                      key: const Key('session-queue-dialog-close'),
                      tooltip: 'Close',
                      onPressed: busy
                          ? null
                          : () => Navigator.of(context).pop(),
                      icon: Icon(LucideIcons.x, size: 18),
                    ),
                  ],
                ),
              ),
              Divider(height: 1, color: colors.outlineVariant),
              Flexible(
                child: SingleChildScrollView(
                  key: const Key('session-queue-dialog-scroll'),
                  padding: const EdgeInsets.all(18),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (_editing)
                        AppTextField(
                          key: const Key('session-queue-edit-field'),
                          controller: _controller,
                          label: 'Message',
                          minLines: 5,
                          maxLines: 12,
                          autofocus: true,
                          textCapitalization: TextCapitalization.sentences,
                          onChanged: (_) => setState(() => _error = null),
                          errorText: _error,
                        )
                      else
                        AppMarkdown(
                          key: const Key('session-queue-dialog-markdown'),
                          data: widget.item.prompt,
                          textStyle: AppTypography.chatMessage(height: 1.5),
                        ),
                      if (widget.item.attachments.isNotEmpty) ...[
                        const SizedBox(height: 14),
                        Wrap(
                          spacing: 8,
                          runSpacing: 6,
                          children: [
                            for (final attachment in widget.item.attachments)
                              Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 9,
                                  vertical: 6,
                                ),
                                decoration: BoxDecoration(
                                  color:
                                      palette?.surfaceHover ?? colors.surface,
                                  border: Border.all(
                                    color: colors.outlineVariant,
                                  ),
                                  borderRadius: BorderRadius.circular(7),
                                ),
                                child: Text(
                                  '📎 ${attachment.label}',
                                  style: AppTypography.mono(
                                    fontSize: 11,
                                    color: colors.onSurfaceVariant,
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ],
                      if (_error != null && !_editing) ...[
                        const SizedBox(height: 12),
                        Text(
                          _error!,
                          style: AppTypography.body(
                            fontSize: 12,
                            color: colors.error,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              Divider(height: 1, color: colors.outlineVariant),
              Padding(
                padding: const EdgeInsets.all(12),
                child: _editing
                    ? Row(
                        children: [
                          Expanded(
                            child: AppButton(
                              key: const Key('session-queue-edit-cancel'),
                              onPressed: busy
                                  ? null
                                  : () => setState(() {
                                      _editing = false;
                                      _controller.text = widget.item.prompt;
                                      _error = null;
                                    }),
                              variant: AppButtonVariant.ghost,
                              size: AppButtonSize.sm,
                              fullWidth: true,
                              child: const Text('Cancel'),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: AppButton(
                              key: const Key('session-queue-edit-save'),
                              onPressed: busy || widget.onEdit == null
                                  ? null
                                  : () {
                                      final prompt = _controller.text.trim();
                                      if (prompt.isEmpty) {
                                        setState(
                                          () => _error =
                                              'Message cannot be empty.',
                                        );
                                        return;
                                      }
                                      _run(
                                        'edit',
                                        () => widget.onEdit!(
                                          widget.item.id,
                                          prompt,
                                        ),
                                      );
                                    },
                              loading: _busyAction == 'edit',
                              size: AppButtonSize.sm,
                              fullWidth: true,
                              child: const Text('Save'),
                            ),
                          ),
                        ],
                      )
                    : Row(
                        children: [
                          Expanded(
                            child: AppButton(
                              key: const Key('session-queue-dialog-steer'),
                              onPressed: busy || widget.onSteer == null
                                  ? null
                                  : () => _run(
                                      'steer',
                                      () => widget.onSteer!(widget.item.id),
                                    ),
                              loading: _busyAction == 'steer',
                              size: AppButtonSize.sm,
                              fullWidth: true,
                              child: Text(context.l10n.steer),
                            ),
                          ),
                          const SizedBox(width: 6),
                          Expanded(
                            child: AppButton(
                              key: const Key('session-queue-dialog-delete'),
                              onPressed: busy || widget.onRemove == null
                                  ? null
                                  : () => _run(
                                      'delete',
                                      () => widget.onRemove!(widget.item.id),
                                    ),
                              loading: _busyAction == 'delete',
                              variant: AppButtonVariant.dangerGhost,
                              size: AppButtonSize.sm,
                              fullWidth: true,
                              child: const Text('Delete'),
                            ),
                          ),
                          const SizedBox(width: 6),
                          Expanded(
                            child: AppButton(
                              key: const Key('session-queue-dialog-edit'),
                              onPressed: busy || widget.onEdit == null
                                  ? null
                                  : () => setState(() => _editing = true),
                              variant: AppButtonVariant.secondary,
                              size: AppButtonSize.sm,
                              fullWidth: true,
                              child: const Text('Edit'),
                            ),
                          ),
                        ],
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _AttachmentChip extends StatelessWidget {
  const _AttachmentChip({required this.attachment, required this.onRemove});

  final NewSessionAttachment attachment;
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      constraints: const BoxConstraints(maxWidth: 190),
      padding: const EdgeInsets.fromLTRB(8, 5, 4, 5),
      decoration: BoxDecoration(
        color: colors.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(7),
        border: Border.all(color: colors.outlineVariant),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            attachment.type == 'image' ? LucideIcons.image : LucideIcons.file,
            size: 13,
            color: colors.onSurfaceVariant,
          ),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              attachment.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppTypography.mono(fontSize: 11, color: colors.onSurface),
            ),
          ),
          IconButton(
            tooltip: 'Remove ${attachment.name}',
            onPressed: onRemove,
            constraints: const BoxConstraints.tightFor(width: 28, height: 28),
            padding: EdgeInsets.zero,
            style: IconButton.styleFrom(
              minimumSize: const Size(28, 28),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            icon: Icon(LucideIcons.x, size: 13, color: colors.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}

class _VoiceDictationStatus extends StatelessWidget {
  const _VoiceDictationStatus({required this.state});

  final VoiceDictationState state;

  @override
  Widget build(BuildContext context) {
    if (state.phase == VoiceDictationPhase.transcribing) {
      return SizedBox(
        key: const Key('session-composer-transcribing'),
        height: AppSpacing.lg,
        child: Row(
          children: [
            const SizedBox(width: AppSpacing.xxs),
            SizedBox.square(
              dimension: AppSpacing.sm,
              child: CircularProgressIndicator(
                strokeWidth: 1.5,
                color: AppThemePalette.of(context).accentStrong,
              ),
            ),
            const SizedBox(width: AppSpacing.xs),
            Text(
              'TRANSCRIBING',
              style: AppTypography.body(
                color: AppThemePalette.of(context).inkMuted,
                fontSize: 10,
                fontWeight: FontWeight.w600,
                letterSpacing: 0.8,
              ),
            ),
          ],
        ),
      );
    }

    final seconds = state.duration.inSeconds;
    final remaining = state.maxDuration - state.duration;
    final showCountdown = remaining <= const Duration(seconds: 15);
    return SizedBox(
      key: const Key('session-composer-recording'),
      height: AppSpacing.lg,
      child: Row(
        children: [
          const SizedBox(width: AppSpacing.xxs),
          const _BlinkingRecordingDot(),
          const SizedBox(width: AppSpacing.xs),
          Text(
            'REC',
            style: AppTypography.body(
              fontSize: 10,
              color: AppThemePalette.of(context).danger,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(width: AppSpacing.xs),
          for (var index = 0; index < 5; index++)
            AnimatedContainer(
              key: Key('session-composer-level-$index'),
              duration: const Duration(milliseconds: 90),
              width: 2,
              height: 4 + 10 * (state.amplitude * (index + 1) / 5),
              margin: const EdgeInsets.only(right: 2),
              decoration: BoxDecoration(
                color: state.amplitude > index / 6
                    ? AppThemePalette.of(context).accentStrong
                    : AppThemePalette.of(context).surfaceActive,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          const SizedBox(width: AppSpacing.xs),
          Text(
            '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}',
            style: AppTypography.body(
              fontSize: 11,
              color: AppThemePalette.of(context).ink,
            ),
          ),
          if (showCountdown) ...[
            const SizedBox(width: AppSpacing.xs),
            Text(
              '${remaining.inSeconds.clamp(0, 15)}s',
              key: const Key('session-composer-recording-countdown'),
              style: AppTypography.body(
                fontSize: 10,
                color: AppThemePalette.of(context).warningStrong,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _BlinkingRecordingDot extends StatefulWidget {
  const _BlinkingRecordingDot();

  @override
  State<_BlinkingRecordingDot> createState() => _BlinkingRecordingDotState();
}

class _BlinkingRecordingDotState extends State<_BlinkingRecordingDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 850),
  )..repeat(reverse: true);
  late final Animation<double> _opacity = Tween<double>(
    begin: 0.35,
    end: 1,
  ).animate(CurvedAnimation(parent: _controller, curve: Curves.easeInOut));

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reduceMotion =
        MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    final dot = Container(
      width: AppSpacing.xs,
      height: AppSpacing.xs,
      decoration: BoxDecoration(
        color: AppThemePalette.of(context).danger,
        shape: BoxShape.circle,
      ),
    );
    if (reduceMotion) return dot;
    return FadeTransition(
      key: const Key('session-composer-recording-dot'),
      opacity: _opacity,
      child: dot,
    );
  }
}

class _VoiceDictationButton extends StatelessWidget {
  const _VoiceDictationButton({
    required this.state,
    required this.enabled,
    required this.onStart,
    required this.onStop,
    required this.onCancel,
  });

  final VoiceDictationState state;
  final bool enabled;
  final VoidCallback? onStart;
  final VoidCallback? onStop;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final recording = state.phase == VoiceDictationPhase.recording;
    final transcribing = state.phase == VoiceDictationPhase.transcribing;
    return IconButton(
      key: const Key('session-composer-voice'),
      tooltip: transcribing
          ? 'Cancel transcription'
          : recording
          ? 'Stop dictation'
          : 'Dictate message',
      onPressed: !enabled
          ? null
          : transcribing
          ? onCancel
          : recording
          ? onStop
          : onStart,
      padding: EdgeInsets.zero,
      alignment: Alignment.centerLeft,
      constraints: const BoxConstraints.tightFor(width: 38, height: 44),
      style: IconButton.styleFrom(
        minimumSize: const Size(38, 44),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        foregroundColor: recording || transcribing
            ? colors.error
            : colors.onSurfaceVariant,
        disabledForegroundColor: colors.onSurfaceVariant.withValues(
          alpha: 0.45,
        ),
      ),
      icon: Container(
        key: const Key('session-composer-voice-visual'),
        width: 32,
        height: 32,
        decoration: BoxDecoration(
          color: recording || transcribing
              ? colors.error.withValues(alpha: 0.14)
              : colors.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(8),
        ),
        alignment: Alignment.center,
        child: Icon(
          transcribing
              ? LucideIcons.x
              : recording
              ? LucideIcons.square
              : LucideIcons.mic,
          size: 16,
        ),
      ),
    );
  }
}

class _ComposerIconButton extends StatelessWidget {
  const _ComposerIconButton({
    super.key,
    required this.tooltip,
    required this.icon,
    required this.onPressed,
    required this.visualKey,
    required this.alignment,
  });

  final String tooltip;
  final IconData icon;
  final VoidCallback? onPressed;
  final Key visualKey;
  final AlignmentGeometry alignment;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return IconButton(
      tooltip: tooltip,
      onPressed: onPressed,
      padding: EdgeInsets.zero,
      alignment: alignment,
      constraints: const BoxConstraints.tightFor(width: 38, height: 44),
      style: IconButton.styleFrom(
        minimumSize: const Size(38, 44),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        foregroundColor: colors.onSurfaceVariant,
        disabledForegroundColor: colors.onSurfaceVariant.withValues(alpha: 0.3),
      ),
      icon: Container(
        key: visualKey,
        width: 32,
        height: 32,
        decoration: BoxDecoration(
          color: colors.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(8),
        ),
        alignment: Alignment.center,
        child: Icon(icon, size: 16),
      ),
    );
  }
}

class _ComposerSubmitButton extends StatelessWidget {
  const _ComposerSubmitButton({
    required this.buttonKey,
    required this.visualKey,
    required this.tooltip,
    required this.icon,
    required this.alignment,
    required this.enabled,
    this.pending = false,
    required this.onPressed,
  });

  final Key buttonKey;
  final Key visualKey;
  final String tooltip;
  final IconData icon;
  final AlignmentGeometry alignment;
  final bool enabled;
  final bool pending;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return IconButton(
      key: buttonKey,
      tooltip: tooltip,
      onPressed: enabled ? onPressed : null,
      padding: EdgeInsets.zero,
      alignment: alignment,
      constraints: const BoxConstraints.tightFor(width: 38, height: 44),
      style: IconButton.styleFrom(
        minimumSize: const Size(38, 44),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        foregroundColor: enabled ? colors.onPrimary : colors.onSurfaceVariant,
        disabledForegroundColor: colors.onSurfaceVariant,
      ),
      icon: Container(
        key: visualKey,
        width: 32,
        height: 32,
        decoration: BoxDecoration(
          color: enabled ? colors.primary : colors.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(8),
        ),
        alignment: Alignment.center,
        child: pending
            ? SizedBox.square(
                dimension: 15,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: colors.onPrimary,
                ),
              )
            : Icon(icon, size: 15),
      ),
    );
  }
}

class _ComposerCapabilityPicker extends StatefulWidget {
  const _ComposerCapabilityPicker({
    super.key,
    required this.providers,
    required this.agent,
    required this.defaultAgent,
    required this.model,
    required this.reasoningEffort,
    required this.inheritedModel,
    required this.inheritedReasoningEffort,
    required this.allowAgentSelection,
    required this.onAgentChanged,
    required this.onModelChanged,
    required this.onReasoningEffortChanged,
  });

  final List<ModelProvider> providers;
  final String? agent;
  final String? defaultAgent;
  final String? model;
  final String? reasoningEffort;
  final String? inheritedModel;
  final String? inheritedReasoningEffort;
  final bool allowAgentSelection;
  final ValueChanged<String?>? onAgentChanged;
  final ValueChanged<String?>? onModelChanged;
  final ValueChanged<String?>? onReasoningEffortChanged;

  @override
  State<_ComposerCapabilityPicker> createState() =>
      _ComposerCapabilityPickerState();
}

class _ComposerCapabilityPickerState extends State<_ComposerCapabilityPicker> {
  bool _open = false;

  ModelProvider get _provider {
    final agent = widget.agent ?? widget.defaultAgent;
    return widget.providers.firstWhere(
      (provider) => provider.agent == agent,
      orElse: () => widget.providers.first,
    );
  }

  Future<void> _showPicker() async {
    if (_open) return;
    setState(() => _open = true);
    var agent = widget.agent ?? widget.defaultAgent ?? _provider.agent;
    var model = widget.model;
    var effort = widget.reasoningEffort;
    await showAppBottomSheet<void>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setSheetState) {
          final provider = widget.providers.firstWhere(
            (item) => item.agent == agent,
            orElse: () => widget.providers.first,
          );
          final initialAgent =
              widget.agent ?? widget.defaultAgent ?? _provider.agent;
          // A session's own model and effort belong to the agent it runs on, so
          // switching agent here leaves only the new provider's marked default.
          final switchedAgent =
              widget.allowAgentSelection && provider.agent != initialAgent;
          final modelChoices = capabilityChoices(
            provider.models,
            model,
            inherited: switchedAgent ? null : widget.inheritedModel,
          );
          final effortChoices = capabilityChoices(
            provider.reasoningEfforts,
            effort,
            inherited: switchedAgent ? null : widget.inheritedReasoningEffort,
          );

          return AppBottomSheet(
            title: widget.allowAgentSelection
                ? 'Agent, model & effort'
                : 'Model & effort',
            handleKey: const Key('session-capabilities-sheet-handle'),
            children: [
              ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: MediaQuery.sizeOf(context).height * 0.68,
                ),
                child: SingleChildScrollView(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (widget.allowAgentSelection)
                        _CapabilityRadioSection(
                          title: 'Agent',
                          choices: [
                            for (final item in widget.providers)
                              CapabilityChoice(
                                value: item.agent,
                                label: item.label,
                                name: item.label,
                                selected: item.agent == agent,
                              ),
                          ],
                          onChanged: (value) {
                            setSheetState(() {
                              agent = value;
                              model = null;
                              effort = null;
                            });
                            widget.onAgentChanged?.call(value);
                          },
                        ),
                      _CapabilityRadioSection(
                        title: 'Model',
                        choices: modelChoices,
                        onChanged: (value) {
                          setSheetState(
                            () => model = value.isEmpty ? null : value,
                          );
                          widget.onModelChanged?.call(
                            value.isEmpty ? null : value,
                          );
                        },
                      ),
                      if (provider.reasoningEfforts.isNotEmpty)
                        _CapabilityRadioSection(
                          title: 'Effort',
                          choices: effortChoices,
                          onChanged: (value) {
                            setSheetState(
                              () => effort = value.isEmpty ? null : value,
                            );
                            widget.onReasoningEffortChanged?.call(
                              value.isEmpty ? null : value,
                            );
                          },
                        ),
                    ],
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
    if (mounted) setState(() => _open = false);
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final provider = _provider;
    final agentLabel = provider.label;
    final modelLabel = capabilityLabel(
      provider.models,
      widget.model,
      inherited: widget.inheritedModel,
    );
    final effortLabel = capabilityLabel(
      provider.reasoningEfforts,
      widget.reasoningEffort,
      inherited: widget.inheritedReasoningEffort,
    );
    final label = '$agentLabel · $modelLabel · $effortLabel';
    return Semantics(
      button: true,
      label: widget.allowAgentSelection
          ? 'Agent, model and effort: $label'
          : 'Model and effort: $label',
      child: InkWell(
        onTap: _showPicker,
        borderRadius: BorderRadius.circular(8),
        child: SizedBox(
          height: 44,
          child: Align(
            alignment: Alignment.centerLeft,
            child: Container(
              key: const Key('session-composer-capabilities-visual'),
              height: 32,
              padding: const EdgeInsets.symmetric(horizontal: 8),
              decoration: BoxDecoration(
                color: colors.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Flexible(
                    child: Text(
                      label,
                      key: const Key('session-composer-capabilities-label'),
                      overflow: TextOverflow.ellipsis,
                      maxLines: 1,
                      style: AppTypography.body(
                        fontSize: AppTypography.composerCapabilityTextSize,
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ),
                  const SizedBox(width: 3),
                  Icon(
                    _open ? LucideIcons.chevronUp : LucideIcons.chevronDown,
                    size: 12,
                    color: colors.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _CapabilityRadioSection extends StatelessWidget {
  const _CapabilityRadioSection({
    required this.title,
    required this.choices,
    required this.onChanged,
  });

  final String title;
  final List<CapabilityChoice> choices;
  final ValueChanged<String> onChanged;

  // Which row the choices themselves say is current — a value that names no
  // listed option simply leaves the group unselected.
  String? get _groupValue {
    for (final choice in choices) {
      if (choice.selected) return choice.value;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 0, 8, 4),
            child: Text(
              title,
              style: AppTypography.body(
                fontSize: AppTypography.composerCapabilityTextSize,
                color: AppThemePalette.of(context).inkFaint,
              ),
            ),
          ),
          RadioGroup<String>(
            groupValue: _groupValue,
            onChanged: (value) {
              if (value != null) onChanged(value);
            },
            child: Column(
              children: [
                for (final choice in choices)
                  RadioListTile<String>(
                    key: ValueKey(
                      'session-capability-${title.toLowerCase()}-'
                      '${choice.name}',
                    ),
                    value: choice.value,
                    title: Text(
                      choice.label,
                      style: AppTypography.body(
                        fontSize: AppTypography.composerCapabilityTextSize,
                        color: AppThemePalette.of(context).ink,
                      ),
                    ),
                    dense: true,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 4),
                    visualDensity: const VisualDensity(
                      horizontal: -2,
                      vertical: -2,
                    ),
                    activeColor: AppThemePalette.of(context).accentStrong,
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
