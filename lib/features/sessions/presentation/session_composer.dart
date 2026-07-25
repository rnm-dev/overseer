import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../shared/design/colors.dart';
import '../../../shared/design/motion.dart';
import '../../../shared/design/typography.dart';
import '../../../shared/widgets/app_bottom_sheet.dart';
import '../domain/followup_repository.dart';
import '../domain/new_session_repository.dart';

class SessionComposer extends StatefulWidget {
  const SessionComposer({
    super.key,
    required this.controller,
    this.enabled = true,
    this.pending = false,
    this.pendingLabel,
    this.running = false,
    this.queuedCount = 0,
    this.queuedItems = const [],
    this.removingQueuedItems = const {},
    this.sendingQueuedItems = const {},
    this.error,
    this.providers = const [],
    this.agent,
    this.defaultAgent,
    this.model,
    this.reasoningEffort,
    this.defaultModelLabel = 'Default',
    this.defaultReasoningEffortLabel = 'Default',
    this.allowAgentSelection = true,
    this.onAgentChanged,
    this.onModelChanged,
    this.onReasoningEffortChanged,
    this.onAttach,
    this.onContentInserted,
    this.attachments = const [],
    this.onRemoveAttachment,
    this.onSubmit,
    this.onStopAndRun,
    this.onRemoveQueued,
    this.onSendQueuedNow,
  });

  final TextEditingController controller;
  final bool enabled;
  final bool pending;
  final String? pendingLabel;
  final bool running;
  final int queuedCount;
  final List<QueuedFollowup> queuedItems;
  final Set<String> removingQueuedItems;
  final Set<String> sendingQueuedItems;
  final String? error;
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
  final VoidCallback? onAttach;
  final ValueChanged<KeyboardInsertedContent>? onContentInserted;
  final List<NewSessionAttachment> attachments;
  final ValueChanged<int>? onRemoveAttachment;
  final VoidCallback? onSubmit;
  final VoidCallback? onStopAndRun;
  final ValueChanged<String>? onRemoveQueued;
  final ValueChanged<String>? onSendQueuedNow;

  @override
  State<SessionComposer> createState() => _SessionComposerState();
}

class _SessionComposerState extends State<SessionComposer> {
  final FocusNode _focusNode = FocusNode();

  bool get _canSubmit =>
      widget.enabled &&
      !widget.pending &&
      (widget.controller.text.trim().isNotEmpty ||
          widget.attachments.isNotEmpty) &&
      widget.onSubmit != null;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_handleTextChanged);
    _focusNode.addListener(_handleFocusChanged);
  }

  @override
  void didUpdateWidget(SessionComposer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_handleTextChanged);
      widget.controller.addListener(_handleTextChanged);
    }
  }

  void _handleTextChanged() => setState(() {});

  void _handleFocusChanged() => setState(() {});

  KeyEventResult _handleComposerKeyEvent(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    if (event.logicalKey != LogicalKeyboardKey.enter &&
        event.logicalKey != LogicalKeyboardKey.numpadEnter) {
      return KeyEventResult.ignored;
    }

    final value = widget.controller.value;
    final selection = value.selection.isValid
        ? value.selection
        : TextSelection.collapsed(offset: value.text.length);
    final text = value.text.replaceRange(selection.start, selection.end, '\n');
    widget.controller.value = value.copyWith(
      text: text,
      selection: TextSelection.collapsed(offset: selection.start + 1),
      composing: TextRange.empty,
    );
    return KeyEventResult.handled;
  }

  void _submit() {
    if (!_canSubmit) return;
    widget.onSubmit?.call();
    _focusNode.unfocus();
  }

  @override
  void dispose() {
    widget.controller.removeListener(_handleTextChanged);
    _focusNode
      ..removeListener(_handleFocusChanged)
      ..dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final borderColor = _focusNode.hasFocus
        ? AppColors.felBright
        : AppColors.iron800;
    return DecoratedBox(
      key: const Key('session-composer-gradient'),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [
            AppColors.voidColor.withValues(alpha: 0),
            AppColors.voidColor.withValues(alpha: 0.9),
            AppColors.voidColor,
          ],
          stops: const [0, 0.34, 1],
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(8, 22, 8, 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (widget.queuedItems.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: _QueuedFollowupList(
                  items: widget.queuedItems,
                  removing: widget.removingQueuedItems,
                  sending: widget.sendingQueuedItems,
                  onRemove: widget.onRemoveQueued,
                  onSendNow: widget.onSendQueuedNow,
                ),
              ),
            AnimatedContainer(
              key: const Key('session-composer-shell'),
              duration: AppMotion.fast,
              padding: const EdgeInsets.fromLTRB(8, 8, 8, 2),
              decoration: BoxDecoration(
                color: AppColors.iron950,
                borderRadius: AppMotion.surfaceShape,
                border: Border.all(color: borderColor),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.48),
                    blurRadius: 28,
                    spreadRadius: -14,
                    offset: const Offset(0, -6),
                  ),
                  if (_focusNode.hasFocus)
                    BoxShadow(
                      color: AppColors.felBright.withValues(alpha: 0.18),
                      blurRadius: 0,
                      spreadRadius: 1,
                    ),
                ],
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (widget.error case final error?)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(4, 2, 4, 4),
                      child: Text(
                        '⚠ $error',
                        key: const Key('session-composer-error'),
                        style: AppTypography.mono(
                          fontSize: 11,
                          color: AppColors.blood,
                        ),
                      ),
                    ),
                  if (widget.queuedCount > 0)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(4, 2, 4, 4),
                      child: Row(
                        children: [
                          const Icon(
                            LucideIcons.hourglass,
                            size: 12,
                            color: AppColors.ember,
                          ),
                          const SizedBox(width: 6),
                          Text(
                            '${widget.queuedCount} '
                            '${widget.queuedCount == 1 ? 'message' : 'messages'} '
                            'waiting to send',
                            key: const Key('session-composer-queued'),
                            style: AppTypography.mono(
                              fontSize: 11,
                              color: AppColors.boneDim,
                            ),
                          ),
                        ],
                      ),
                    ),
                  if (widget.pending && widget.pendingLabel != null)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(4, 2, 4, 4),
                      child: Text(
                        widget.pendingLabel!,
                        key: const Key('session-composer-pending-label'),
                        style: AppTypography.mono(
                          fontSize: 11,
                          color: AppColors.boneDim,
                        ),
                      ),
                    ),
                  if (widget.attachments.isNotEmpty)
                    Padding(
                      key: const Key('session-composer-attachments'),
                      padding: const EdgeInsets.fromLTRB(2, 2, 2, 6),
                      child: Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: [
                          for (
                            var index = 0;
                            index < widget.attachments.length;
                            index++
                          )
                            _AttachmentChip(
                              attachment: widget.attachments[index],
                              onRemove: widget.pending
                                  ? null
                                  : () =>
                                        widget.onRemoveAttachment?.call(index),
                            ),
                        ],
                      ),
                    ),
                  ConstrainedBox(
                    constraints: const BoxConstraints(
                      minHeight: 32,
                      maxHeight: 160,
                    ),
                    child: Focus(
                      onKeyEvent: _handleComposerKeyEvent,
                      child: Semantics(
                        identifier: 'session-composer-message',
                        label: 'Message',
                        value: widget.controller.text,
                        textField: true,
                        enabled: widget.enabled && !widget.pending,
                        onTap: _focusNode.requestFocus,
                        child: ExcludeSemantics(
                          child: TextField(
                            key: const Key('session-composer-input'),
                            controller: widget.controller,
                            focusNode: _focusNode,
                            enabled: widget.enabled && !widget.pending,
                            minLines: 1,
                            maxLines: null,
                            keyboardType: TextInputType.multiline,
                            textInputAction: TextInputAction.newline,
                            contentInsertionConfiguration:
                                widget.onContentInserted == null
                                ? null
                                : ContentInsertionConfiguration(
                                    allowedMimeTypes: const [
                                      'image/png',
                                      'image/jpeg',
                                      'image/gif',
                                      'image/webp',
                                    ],
                                    onContentInserted:
                                        widget.onContentInserted!,
                                  ),
                            style: AppTypography.body(
                              fontSize: 14,
                              height: 1.35,
                            ),
                            decoration: InputDecoration(
                              hintText: 'Send a message…',
                              hintStyle: AppTypography.body(
                                fontSize: 14,
                                color: AppColors.boneFaint,
                              ),
                              filled: false,
                              isDense: true,
                              contentPadding: const EdgeInsets.symmetric(
                                horizontal: 4,
                                vertical: 4,
                              ),
                              border: InputBorder.none,
                              enabledBorder: InputBorder.none,
                              focusedBorder: InputBorder.none,
                              disabledBorder: InputBorder.none,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      _ComposerIconButton(
                        key: const Key('session-composer-attach'),
                        visualKey: const Key('session-composer-attach-visual'),
                        tooltip: 'Attach files',
                        icon: LucideIcons.plus,
                        alignment: Alignment.centerLeft,
                        onPressed: widget.enabled && !widget.pending
                            ? widget.onAttach
                            : null,
                      ),
                      if (widget.providers.isNotEmpty) ...[
                        Expanded(
                          child: _ComposerCapabilityPicker(
                            key: const Key('session-composer-capabilities'),
                            providers: widget.providers,
                            agent: widget.agent,
                            defaultAgent: widget.defaultAgent,
                            model: widget.model,
                            reasoningEffort: widget.reasoningEffort,
                            defaultModelLabel: widget.defaultModelLabel,
                            defaultReasoningEffortLabel:
                                widget.defaultReasoningEffortLabel,
                            allowAgentSelection: widget.allowAgentSelection,
                            onAgentChanged: widget.onAgentChanged,
                            onModelChanged: widget.onModelChanged,
                            onReasoningEffortChanged:
                                widget.onReasoningEffortChanged,
                          ),
                        ),
                      ],
                      if (widget.providers.isEmpty) const Spacer(),
                      if (widget.running) ...[
                        _ComposerSubmitButton(
                          buttonKey: const Key('session-composer-stop-and-run'),
                          visualKey: const Key(
                            'session-composer-stop-and-run-visual',
                          ),
                          tooltip: 'Send now',
                          icon: LucideIcons.sendHorizontal,
                          alignment: Alignment.centerRight,
                          enabled: _canSubmit && widget.onStopAndRun != null,
                          onPressed: widget.onStopAndRun,
                        ),
                      ],
                      _ComposerSubmitButton(
                        buttonKey: const Key('session-composer-submit'),
                        visualKey: const Key('session-composer-submit-visual'),
                        tooltip: widget.running ? 'Queue' : 'Send',
                        icon: widget.running
                            ? LucideIcons.listPlus
                            : LucideIcons.sendHorizontal,
                        alignment: Alignment.centerRight,
                        enabled: _canSubmit,
                        pending: widget.pending,
                        onPressed: _submit,
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _QueuedFollowupList extends StatelessWidget {
  const _QueuedFollowupList({
    required this.items,
    required this.removing,
    required this.sending,
    required this.onRemove,
    required this.onSendNow,
  });

  final List<QueuedFollowup> items;
  final Set<String> removing;
  final Set<String> sending;
  final ValueChanged<String>? onRemove;
  final ValueChanged<String>? onSendNow;

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
            final isRemoving = removing.contains(item.id);
            final isSending = sending.contains(item.id);
            final busy = isRemoving || isSending;
            return Align(
              alignment: Alignment.centerRight,
              child: FractionallySizedBox(
                widthFactor: 0.8,
                child: Container(
                  key: Key('session-queue-item-${item.id}'),
                  padding: const EdgeInsets.fromLTRB(10, 8, 2, 8),
                  decoration: BoxDecoration(
                    color: AppColors.iron900.withValues(alpha: 0.78),
                    borderRadius: const BorderRadius.only(
                      topLeft: Radius.circular(12),
                      topRight: Radius.circular(12),
                      bottomLeft: Radius.circular(12),
                      bottomRight: Radius.circular(3),
                    ),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withValues(alpha: 0.28),
                        blurRadius: 14,
                        offset: const Offset(0, 5),
                      ),
                    ],
                  ),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Padding(
                        padding: const EdgeInsets.only(top: 3),
                        child: Icon(
                          LucideIcons.hourglass,
                          size: 13,
                          color: isSending
                              ? AppColors.ember
                              : AppColors.ember.withValues(alpha: 0.7),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              item.prompt,
                              style: AppTypography.body(
                                fontSize: 14,
                                height: 1.35,
                              ),
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
                      _QueueActionButton(
                        key: Key('session-queue-send-${item.id}'),
                        tooltip: 'Send now',
                        icon: LucideIcons.send,
                        busy: isSending,
                        enabled: !busy && onSendNow != null,
                        color: AppColors.ember,
                        onPressed: () => onSendNow?.call(item.id),
                      ),
                      _QueueActionButton(
                        key: Key('session-queue-remove-${item.id}'),
                        tooltip: 'Remove queued follow-up',
                        icon: LucideIcons.trash2,
                        busy: isRemoving,
                        enabled: !busy && onRemove != null,
                        color: AppColors.boneFaint,
                        onPressed: () => onRemove?.call(item.id),
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

class _QueueActionButton extends StatelessWidget {
  const _QueueActionButton({
    super.key,
    required this.tooltip,
    required this.icon,
    required this.busy,
    required this.enabled,
    required this.color,
    required this.onPressed,
  });

  final String tooltip;
  final IconData icon;
  final bool busy;
  final bool enabled;
  final Color color;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      tooltip: tooltip,
      onPressed: enabled ? onPressed : null,
      constraints: const BoxConstraints.tightFor(width: 42, height: 44),
      padding: EdgeInsets.zero,
      style: IconButton.styleFrom(
        minimumSize: const Size(42, 44),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      ),
      icon: Container(
        width: 28,
        height: 28,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: Colors.black.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(6),
        ),
        child: busy
            ? SizedBox.square(
                dimension: 13,
                child: CircularProgressIndicator(
                  strokeWidth: 1.8,
                  color: color,
                ),
              )
            : Icon(
                icon,
                size: icon == LucideIcons.trash2 ? 15 : 13,
                color: color,
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
