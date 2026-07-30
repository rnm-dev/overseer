import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../shared/design/colors.dart';
import '../../../shared/design/motion.dart';
import '../../../shared/design/spacing.dart';
import '../../../shared/design/typography.dart';
import '../../../shared/models/ai_capabilities.dart';
import '../../../shared/widgets/app_bottom_sheet.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_markdown.dart';
import '../../../shared/widgets/app_text_field.dart';
import '../application/voice_dictation_controller.dart';
import '../domain/followup_repository.dart';
import '../domain/new_session_repository.dart';
part 'session_composer_queue.dart';

TextEditingValue insertVoiceTranscript(
  TextEditingValue value,
  String transcript,
) {
  final selection = value.selection.isValid
      ? value.selection
      : TextSelection.collapsed(offset: value.text.length);
  var insertion = transcript.trim();
  if (insertion.isEmpty) return value;
  if (selection.start > 0 &&
      !_isWhitespace(value.text.codeUnitAt(selection.start - 1))) {
    insertion = ' $insertion';
  }
  if (selection.end < value.text.length &&
      !_isWhitespace(value.text.codeUnitAt(selection.end))) {
    insertion = '$insertion ';
  }
  final text = value.text.replaceRange(
    selection.start,
    selection.end,
    insertion,
  );
  return value.copyWith(
    text: text,
    selection: TextSelection.collapsed(
      offset: selection.start + insertion.length,
    ),
    composing: TextRange.empty,
  );
}

bool _isWhitespace(int codeUnit) =>
    codeUnit == 0x20 ||
    codeUnit == 0x09 ||
    codeUnit == 0x0a ||
    codeUnit == 0x0d;

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
    this.editingQueuedItems = const {},
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
    this.onEditQueued,
    this.onSendQueuedNow,
    this.dictation,
    this.onVoiceStart,
    this.onVoiceStop,
    this.onVoiceCancel,
  });

  final TextEditingController controller;
  final bool enabled;
  final bool pending;
  final String? pendingLabel;
  final bool running;
  final int queuedCount;
  final List<QueuedFollowup> queuedItems;
  final Set<String> editingQueuedItems;
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
  final Future<void> Function(String itemId)? onRemoveQueued;
  final Future<void> Function(String itemId, String prompt)? onEditQueued;
  final Future<void> Function(String itemId)? onSendQueuedNow;
  final VoiceDictationState? dictation;
  final VoidCallback? onVoiceStart;
  final VoidCallback? onVoiceStop;
  final VoidCallback? onVoiceCancel;

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
    final dictationActive =
        widget.dictation?.phase == VoiceDictationPhase.recording ||
        widget.dictation?.phase == VoiceDictationPhase.transcribing;
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
                  editing: widget.editingQueuedItems,
                  removing: widget.removingQueuedItems,
                  sending: widget.sendingQueuedItems,
                  onEdit: widget.onEditQueued,
                  onRemove: widget.onRemoveQueued,
                  onSendNow: widget.onSendQueuedNow,
                ),
              ),
            AnimatedContainer(
              key: const Key('session-composer-shell'),
              duration: AppMotion.fast,
              padding: EdgeInsets.fromLTRB(
                AppSpacing.xs,
                dictationActive ? AppSpacing.xxs : AppSpacing.xs,
                AppSpacing.xs,
                AppSpacing.xxs,
              ),
              decoration: BoxDecoration(
                color: AppColors.iron950,
                borderRadius: AppMotion.surfaceShape,
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
              foregroundDecoration: BoxDecoration(
                borderRadius: AppMotion.surfaceShape,
                border: Border.all(color: borderColor),
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
                  if (widget.dictation?.phase ==
                          VoiceDictationPhase.recording ||
                      widget.dictation?.phase ==
                          VoiceDictationPhase.transcribing)
                    _VoiceDictationStatus(state: widget.dictation!),
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
                              fontSize: AppTypography.composerInputFontSize,
                              height: 1.35,
                            ),
                            decoration: InputDecoration(
                              hintText: 'Send a message…',
                              hintStyle: AppTypography.body(
                                fontSize: AppTypography.composerInputFontSize,
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
                      if (widget.dictation?.showMicrophone == true)
                        _VoiceDictationButton(
                          state: widget.dictation!,
                          enabled: widget.enabled && !widget.pending,
                          onStart: widget.onVoiceStart,
                          onStop: widget.onVoiceStop,
                          onCancel: widget.onVoiceCancel,
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
