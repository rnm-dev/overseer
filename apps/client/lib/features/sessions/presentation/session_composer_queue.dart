part of 'session_composer.dart';

class _QueuedFollowupList extends StatelessWidget {
  const _QueuedFollowupList({
    required this.items,
    required this.editing,
    required this.removing,
    required this.sending,
    required this.onEdit,
    required this.onRemove,
    required this.onSendNow,
  });

  final List<QueuedFollowup> items;
  final Set<String> editing;
  final Set<String> removing;
  final Set<String> sending;
  final Future<void> Function(String itemId, String prompt)? onEdit;
  final Future<void> Function(String itemId)? onRemove;
  final Future<void> Function(String itemId)? onSendNow;

  @override
  Widget build(BuildContext context) {
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
            return Material(
              key: Key('session-queue-item-${item.id}'),
              color: AppColors.iron900.withValues(alpha: 0.78),
              borderRadius: const BorderRadius.only(
                topLeft: Radius.circular(12),
                topRight: Radius.circular(12),
                bottomLeft: Radius.circular(12),
                bottomRight: Radius.circular(3),
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
                        onSendNow: onSendNow,
                      ),
                borderRadius: const BorderRadius.only(
                  topLeft: Radius.circular(12),
                  topRight: Radius.circular(12),
                  bottomLeft: Radius.circular(12),
                  bottomRight: Radius.circular(3),
                ),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Padding(
                        padding: const EdgeInsets.only(top: 3),
                        child: busy
                            ? const SizedBox.square(
                                dimension: 13,
                                child: CircularProgressIndicator(
                                  strokeWidth: 1.8,
                                  color: AppColors.ember,
                                ),
                              )
                            : Icon(
                                LucideIcons.hourglass,
                                size: 13,
                                color: AppColors.ember.withValues(alpha: 0.7),
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
                                        color: AppColors.boneFaint,
                                      ),
                                    ),
                                ],
                              ),
                            ],
                          ],
                        ),
                      ),
                      const SizedBox(width: 6),
                      const Padding(
                        padding: EdgeInsets.only(top: 2),
                        child: Icon(
                          LucideIcons.maximize2,
                          size: 14,
                          color: AppColors.boneFaint,
                        ),
                      ),
                    ],
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
  required Future<void> Function(String itemId)? onSendNow,
}) {
  return showGeneralDialog<void>(
    context: context,
    barrierDismissible: true,
    barrierLabel: 'Close queued message',
    barrierColor: Colors.black.withValues(alpha: 0.72),
    transitionDuration: AppMotion.backdropFade,
    pageBuilder: (_, _, _) => _QueuedFollowupDialog(
      item: item,
      onEdit: onEdit,
      onRemove: onRemove,
      onSendNow: onSendNow,
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
    required this.onSendNow,
  });

  final QueuedFollowup item;
  final Future<void> Function(String itemId, String prompt)? onEdit;
  final Future<void> Function(String itemId)? onRemove;
  final Future<void> Function(String itemId)? onSendNow;

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
            color: AppColors.iron950,
            border: Border.all(color: AppColors.iron700),
            borderRadius: AppMotion.surfaceShape,
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.48),
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
                      icon: const Icon(LucideIcons.x, size: 18),
                    ),
                  ],
                ),
              ),
              const Divider(height: 1, color: AppColors.iron800),
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
                          textStyle: AppTypography.chatMessage(
                            height: 1.5,
                          ),
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
                                  color: AppColors.iron900,
                                  border: Border.all(color: AppColors.iron700),
                                  borderRadius: BorderRadius.circular(7),
                                ),
                                child: Text(
                                  '📎 ${attachment.label}',
                                  style: AppTypography.mono(
                                    fontSize: 11,
                                    color: AppColors.boneDim,
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
                            color: AppColors.blood,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              const Divider(height: 1, color: AppColors.iron800),
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
                              key: const Key('session-queue-dialog-send'),
                              onPressed: busy || widget.onSendNow == null
                                  ? null
                                  : () => _run(
                                      'send',
                                      () => widget.onSendNow!(widget.item.id),
                                    ),
                              loading: _busyAction == 'send',
                              size: AppButtonSize.sm,
                              fullWidth: true,
                              child: const Text('Send now'),
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
                              variant: AppButtonVariant.danger,
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
    return Container(
      constraints: const BoxConstraints(maxWidth: 190),
      padding: const EdgeInsets.fromLTRB(8, 5, 4, 5),
      decoration: BoxDecoration(
        color: AppColors.iron900,
        borderRadius: BorderRadius.circular(7),
        border: Border.all(color: AppColors.iron800),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            attachment.type == 'image' ? LucideIcons.image : LucideIcons.file,
            size: 13,
            color: AppColors.boneFaint,
          ),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              attachment.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppTypography.mono(fontSize: 11, color: AppColors.boneDim),
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
            icon: const Icon(
              LucideIcons.x,
              size: 13,
              color: AppColors.boneFaint,
            ),
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
            const SizedBox.square(
              dimension: AppSpacing.sm,
              child: CircularProgressIndicator(
                strokeWidth: 1.5,
                color: AppColors.felBright,
              ),
            ),
            const SizedBox(width: AppSpacing.xs),
            Text(
              'TRANSCRIBING',
              style: AppTypography.body(
                color: AppColors.boneDim,
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
              color: AppColors.blood,
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
                    ? AppColors.felBright
                    : AppColors.iron700,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          const SizedBox(width: AppSpacing.xs),
          Text(
            '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}',
            style: AppTypography.body(fontSize: 11, color: AppColors.bone),
          ),
          if (showCountdown) ...[
            const SizedBox(width: AppSpacing.xs),
            Text(
              '${remaining.inSeconds.clamp(0, 15)}s',
              key: const Key('session-composer-recording-countdown'),
              style: AppTypography.body(fontSize: 10, color: AppColors.ember),
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
      decoration: const BoxDecoration(
        color: AppColors.blood,
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
            ? AppColors.blood
            : AppColors.boneFaint,
        disabledForegroundColor: AppColors.boneFaint.withValues(alpha: 0.45),
      ),
      icon: Container(
        key: const Key('session-composer-voice-visual'),
        width: 32,
        height: 32,
        decoration: BoxDecoration(
          color: recording || transcribing
              ? AppColors.blood.withValues(alpha: 0.14)
              : AppColors.iron900,
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
    return IconButton(
      tooltip: tooltip,
      onPressed: onPressed,
      padding: EdgeInsets.zero,
      alignment: alignment,
      constraints: const BoxConstraints.tightFor(width: 38, height: 44),
      style: IconButton.styleFrom(
        minimumSize: const Size(38, 44),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        foregroundColor: AppColors.boneFaint,
        disabledForegroundColor: AppColors.boneFaint.withValues(alpha: 0.3),
      ),
      icon: Container(
        key: visualKey,
        width: 32,
        height: 32,
        decoration: BoxDecoration(
          color: AppColors.iron900,
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
        foregroundColor: enabled ? AppColors.felInk : AppColors.boneFaint,
        disabledForegroundColor: AppColors.boneFaint,
      ),
      icon: Container(
        key: visualKey,
        width: 32,
        height: 32,
        decoration: BoxDecoration(
          color: enabled ? AppColors.fel : AppColors.iron900,
          borderRadius: BorderRadius.circular(8),
        ),
        alignment: Alignment.center,
        child: pending
            ? const SizedBox.square(
                dimension: 15,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: AppColors.boneDim,
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
    required this.defaultModelLabel,
    required this.defaultReasoningEffortLabel,
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
  final String defaultModelLabel;
  final String defaultReasoningEffortLabel;
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

  String _optionLabel(
    List<ModelCatalogOption> options,
    String? value,
    String fallback,
  ) {
    if (value == null) return fallback;
    for (final option in options) {
      if (option.id == value || option.alias == value) return option.label;
    }
    return value;
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
          final switchedAgent =
              widget.allowAgentSelection && provider.agent != initialAgent;
          String defaultLabel(
            List<ModelCatalogOption> options,
            String fallback,
          ) {
            if (!switchedAgent) {
              return fallback == 'Default' ? fallback : 'Default · $fallback';
            }
            for (final option in options) {
              if (option.isDefault) return 'Default · ${option.label}';
            }
            return 'Default';
          }

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
                          value: agent,
                          options: [
                            for (final item in widget.providers)
                              _CapabilityOption(
                                value: item.agent,
                                label: item.label,
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
                        value: model ?? '',
                        options: [
                          _CapabilityOption(
                            value: '',
                            label: defaultLabel(
                              provider.models,
                              widget.defaultModelLabel,
                            ),
                          ),
                          for (final option in provider.models)
                            _CapabilityOption(
                              value: option.id,
                              label: option.label,
                            ),
                        ],
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
                          value: effort ?? '',
                          options: [
                            _CapabilityOption(
                              value: '',
                              label: defaultLabel(
                                provider.reasoningEfforts,
                                widget.defaultReasoningEffortLabel,
                              ),
                            ),
                            for (final option in provider.reasoningEfforts)
                              _CapabilityOption(
                                value: option.id,
                                label: option.label,
                              ),
                          ],
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
    final provider = _provider;
    final agentLabel = provider.label;
    final modelLabel = _optionLabel(
      provider.models,
      widget.model,
      widget.defaultModelLabel,
    );
    final effortLabel = _optionLabel(
      provider.reasoningEfforts,
      widget.reasoningEffort,
      widget.defaultReasoningEffortLabel,
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
                color: AppColors.iron900,
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
                      style: AppTypography.mono(
                        fontSize: 11,
                        color: AppColors.boneDim,
                      ),
                    ),
                  ),
                  const SizedBox(width: 3),
                  Icon(
                    _open ? LucideIcons.chevronUp : LucideIcons.chevronDown,
                    size: 12,
                    color: AppColors.boneFaint,
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

class _CapabilityOption {
  const _CapabilityOption({required this.value, required this.label});

  final String value;
  final String label;
}

class _CapabilityRadioSection extends StatelessWidget {
  const _CapabilityRadioSection({
    required this.title,
    required this.value,
    required this.options,
    required this.onChanged,
  });

  final String title;
  final String value;
  final List<_CapabilityOption> options;
  final ValueChanged<String> onChanged;

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
              style: AppTypography.mono(
                fontSize: 11,
                color: AppColors.boneFaint,
              ),
            ),
          ),
          RadioGroup<String>(
            groupValue: value,
            onChanged: (value) {
              if (value != null) onChanged(value);
            },
            child: Column(
              children: [
                for (final option in options)
                  RadioListTile<String>(
                    key: ValueKey(
                      'session-capability-${title.toLowerCase()}-'
                      '${option.value}',
                    ),
                    value: option.value,
                    title: Text(
                      option.label,
                      style: AppTypography.body(
                        fontSize: 14,
                        color: AppColors.bone,
                      ),
                    ),
                    dense: true,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 4),
                    visualDensity: const VisualDensity(
                      horizontal: -2,
                      vertical: -2,
                    ),
                    activeColor: AppColors.felBright,
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
