import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../shared/design/typography.dart';
import '../../../shared/formatters/activity_timestamp.dart';
import '../../../shared/widgets/app_markdown.dart';
import '../../../l10n/app_localizations.dart';
import '../../auth/domain/auth_models.dart';
import '../../settings/domain/tool_display_mode.dart';
import '../domain/session_models.dart';
import 'tool_details_bottom_sheet.dart';
import 'selected_text_reply_selection_area.dart';
import 'transcript_items.dart';

class TranscriptItemView extends StatelessWidget {
  const TranscriptItemView({
    super.key,
    required this.item,
    this.thinkingLabel = 'Thinking',
    this.toolDisplayMode = ToolDisplayMode.technical,
    this.operator,
    this.onOpenAttachment,
    this.onOpenPreview,
    this.onOpenLink,
    this.onSelectedText,
    this.onOpenReplySource,
  });

  final TranscriptItem item;
  final String thinkingLabel;
  final ToolDisplayMode toolDisplayMode;
  final OperatorIdentity? operator;
  final ValueChanged<TranscriptAttachment>? onOpenAttachment;
  final ValueChanged<TranscriptPreviewItem>? onOpenPreview;
  final ValueChanged<String>? onOpenLink;
  final ValueChanged<SelectedTextReply>? onSelectedText;
  final ValueChanged<SelectedTextReply>? onOpenReplySource;

  @override
  Widget build(BuildContext context) {
    return switch (item) {
      TranscriptUserItem user => _UserBubble(
        item: user,
        operator: operator,
        onOpenAttachment: onOpenAttachment,
        onOpenLink: onOpenLink,
        onSelectedText: onSelectedText,
        onOpenReplySource: onOpenReplySource,
      ),
      TranscriptTextItem text => _AssistantText(
        item: text,
        onOpenLink: onOpenLink,
        onSelectedText: onSelectedText,
      ),
      TranscriptThinkingItem thinking => _ThinkingRow(
        item: thinking,
        label: thinkingLabel,
      ),
      TranscriptToolItem tool => _ToolRow(
        item: tool,
        displayMode: toolDisplayMode,
      ),
      TranscriptLooseItem loose => _ActionResult(item: loose),
      TranscriptNoticeItem notice => _Notice(item: notice),
      TranscriptPreviewItem preview => _PreviewCard(
        item: preview,
        onOpen: onOpenPreview,
      ),
      TranscriptRawItem raw => _RawText(item: raw),
    };
  }
}

class _UserBubble extends StatelessWidget {
  const _UserBubble({
    required this.item,
    required this.operator,
    required this.onOpenAttachment,
    required this.onOpenLink,
    this.onSelectedText,
    this.onOpenReplySource,
  });

  final TranscriptUserItem item;
  final OperatorIdentity? operator;
  final ValueChanged<TranscriptAttachment>? onOpenAttachment;
  final ValueChanged<String>? onOpenLink;
  final ValueChanged<SelectedTextReply>? onSelectedText;
  final ValueChanged<SelectedTextReply>? onOpenReplySource;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final mine = _isOwnMessage(item, operator);
    final author =
        item.authorGithubLogin ?? item.authorEmail ?? item.author ?? 'Operator';
    final compact =
        item.text.trim().isNotEmpty &&
        item.text.trim().length <= 48 &&
        !item.text.contains('\n') &&
        item.attachments.isEmpty;
    final timestamp = formatActivityTimestamp(item.createdAt);
    return Row(
      mainAxisAlignment: MainAxisAlignment.end,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Flexible(
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: MediaQuery.sizeOf(context).width * 0.8,
            ),
            child: DecoratedBox(
              key: Key('transcript-user-${item.key}'),
              decoration: BoxDecoration(
                color: mine
                    ? colors.primaryContainer
                    : colors.surfaceContainerHighest,
                border: mine ? null : Border.all(color: colors.outlineVariant),
                borderRadius: const BorderRadius.only(
                  topLeft: Radius.circular(12),
                  topRight: Radius.circular(12),
                  bottomLeft: Radius.circular(12),
                  bottomRight: Radius.circular(3),
                ),
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 7,
                ),
                child: Column(
                  crossAxisAlignment: compact
                      ? CrossAxisAlignment.start
                      : CrossAxisAlignment.stretch,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (!mine && author.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 4),
                        child: Text(
                          author,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: AppTypography.body(
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                            color: colors.primary,
                            height: 1.15,
                          ),
                        ),
                      ),
                    if (item.replyTo case final reply?)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: _SelectedTextReplyCard(
                          replyTo: reply,
                          onOpenSource: onOpenReplySource == null
                              ? null
                              : () => onOpenReplySource!(reply),
                        ),
                      ),
                    if (compact)
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Flexible(
                            child: _UserText(
                              text: item.text,
                              onOpenLink: onOpenLink,
                              replyEventId: item.sourceEventId,
                              onReply: onSelectedText,
                            ),
                          ),
                          if (timestamp != null) ...[
                            const SizedBox(width: 12),
                            _Timestamp(text: timestamp, mine: mine),
                          ],
                        ],
                      )
                    else if (item.text.isNotEmpty)
                      _UserText(
                        text: item.text,
                        onOpenLink: onOpenLink,
                        replyEventId: item.sourceEventId,
                        onReply: onSelectedText,
                      ),
                    if (item.attachments.isNotEmpty) ...[
                      if (item.text.isNotEmpty) const SizedBox(height: 8),
                      for (final attachment in item.attachments)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 4),
                          child: _AttachmentPill(
                            attachment: attachment,
                            mine: mine,
                            onTap:
                                attachment.path?.trim().isNotEmpty == true &&
                                    onOpenAttachment != null
                                ? () => onOpenAttachment!(attachment)
                                : null,
                          ),
                        ),
                    ],
                    if (!compact && timestamp != null)
                      Align(
                        alignment: Alignment.centerRight,
                        child: Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: _Timestamp(text: timestamp, mine: mine),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
        const SizedBox(width: 8),
        _Avatar(
          label: author,
          imageUrl: item.authorAvatarUrl ?? (mine ? operator?.avatarUrl : null),
        ),
      ],
    );
  }
}

class _UserText extends StatelessWidget {
  const _UserText({
    required this.text,
    required this.onOpenLink,
    this.replyEventId,
    this.onReply,
  });

  final String text;
  final ValueChanged<String>? onOpenLink;
  final String? replyEventId;
  final ValueChanged<SelectedTextReply>? onReply;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return SelectedTextReplySelectionArea(
      eventId: replyEventId,
      onReply: onReply,
      child: AppMarkdown(
        data: text,
        onTapLink: onOpenLink,
        textStyle: AppTypography.chatMessage(
          color: colors.onPrimaryContainer,
          height: 1.35,
        ),
      ),
    );
  }
}

class _SelectedTextReplyCard extends StatelessWidget {
  const _SelectedTextReplyCard({required this.replyTo, this.onOpenSource});

  final SelectedTextReply replyTo;
  final VoidCallback? onOpenSource;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final preview = replyTo.selectedText.length > 240
        ? '${replyTo.selectedText.substring(0, 240)}…'
        : replyTo.selectedText;
    final card = Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      decoration: BoxDecoration(
        color: colors.primary.withValues(alpha: 0.06),
        border: Border.all(color: colors.primary.withValues(alpha: 0.25)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.subdirectory_arrow_left, size: 14, color: colors.primary),
          const SizedBox(width: 6),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Selected text',
                  style: AppTypography.mono(
                    fontSize: 9,
                    color: colors.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  preview,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: AppTypography.body(
                    fontSize: 11,
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
    if (onOpenSource == null) return card;
    return InkWell(
      onTap: onOpenSource,
      borderRadius: BorderRadius.circular(8),
      child: card,
    );
  }
}

class _Timestamp extends StatelessWidget {
  const _Timestamp({required this.text, required this.mine});

  final String text;
  final bool mine;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Text(
      text,
      style: AppTypography.body(
        fontSize: 10,
        color: mine
            ? colors.onPrimaryContainer.withValues(alpha: 0.65)
            : colors.onSurfaceVariant,
        height: 1.1,
      ),
    );
  }
}

class _Avatar extends StatelessWidget {
  const _Avatar({required this.label, this.imageUrl});

  final String label;
  final String? imageUrl;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final initial = label.trim().isEmpty ? '?' : label.trim()[0].toUpperCase();
    return Container(
      width: 28,
      height: 28,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: colors.primaryContainer,
        border: Border.all(color: colors.primary.withValues(alpha: 0.35)),
      ),
      child: imageUrl?.trim().isNotEmpty == true
          ? Image.network(
              imageUrl!,
              fit: BoxFit.cover,
              errorBuilder: (_, _, _) => Center(child: _AvatarInitial(initial)),
            )
          : Center(child: _AvatarInitial(initial)),
    );
  }
}

class _AvatarInitial extends StatelessWidget {
  const _AvatarInitial(this.initial);

  final String initial;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Text(
      initial,
      style: AppTypography.body(
        fontSize: 11,
        fontWeight: FontWeight.w700,
        color: colors.onPrimaryContainer,
      ),
    );
  }
}

class _AttachmentPill extends StatelessWidget {
  const _AttachmentPill({
    required this.attachment,
    required this.mine,
    this.onTap,
  });

  final TranscriptAttachment attachment;
  final bool mine;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Material(
      color: mine
          ? colors.onPrimaryContainer.withValues(alpha: 0.08)
          : colors.surface,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        key: Key('transcript-attachment-${attachment.label}'),
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 28,
                height: 28,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: mine
                      ? colors.onPrimaryContainer.withValues(alpha: 0.1)
                      : colors.primaryContainer,
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Icon(
                  attachment.type == 'image'
                      ? LucideIcons.image
                      : LucideIcons.paperclip,
                  size: 14,
                  color: mine
                      ? colors.onPrimaryContainer.withValues(alpha: 0.8)
                      : colors.primary,
                ),
              ),
              const SizedBox(width: 10),
              Flexible(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      attachment.label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppTypography.display(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      _attachmentMeta(attachment),
                      style: AppTypography.mono(
                        fontSize: 10,
                        color: mine
                            ? colors.onPrimaryContainer.withValues(alpha: 0.6)
                            : colors.onSurfaceVariant,
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

class _AssistantText extends StatelessWidget {
  const _AssistantText({
    required this.item,
    required this.onOpenLink,
    this.onSelectedText,
  });

  final TranscriptTextItem item;
  final ValueChanged<String>? onOpenLink;
  final ValueChanged<SelectedTextReply>? onSelectedText;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final timestamp = formatActivityTimestamp(item.createdAt);
    return Column(
      key: Key('transcript-text-${item.key}'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SelectedTextReplySelectionArea(
          eventId: item.sourceEventId,
          onReply: onSelectedText,
          child: AppMarkdown(
            key: Key('transcript-markdown-${item.key}'),
            data: item.text,
            onTapLink: onOpenLink,
            textStyle: AppTypography.chatMessage(
              color: colors.onSurface,
              height: 1.55,
            ),
          ),
        ),
        if (timestamp != null || item.resultMeta != null)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Wrap(
              spacing: 6,
              runSpacing: 2,
              children: [
                if (timestamp != null)
                  Text(
                    timestamp,
                    style: AppTypography.body(
                      fontSize: 10,
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                if (timestamp != null && item.resultMeta != null)
                  Text(
                    '·',
                    style: AppTypography.body(
                      fontSize: 10,
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                if (item.resultMeta case final meta?)
                  Text(
                    meta.text,
                    key: Key('transcript-result-${item.key}'),
                    style: AppTypography.body(
                      fontSize: 10,
                      color: meta.isError
                          ? colors.error
                          : colors.onSurfaceVariant,
                    ),
                  ),
              ],
            ),
          ),
      ],
    );
  }
}

class _ThinkingRow extends StatefulWidget {
  const _ThinkingRow({required this.item, required this.label});

  final TranscriptThinkingItem item;
  final String label;

  @override
  State<_ThinkingRow> createState() => _ThinkingRowState();
}

class _ThinkingRowState extends State<_ThinkingRow> {
  bool open = false;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.85,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            InkWell(
              key: Key('transcript-thinking-${widget.item.key}'),
              onTap: () => setState(() => open = !open),
              borderRadius: BorderRadius.circular(4),
              child: Text(
                '✦ ${widget.label} ${open ? '▾' : '▸'}',
                style: AppTypography.mono(
                  fontSize: AppTypography.systemMessageFontSize,
                  color: colors.onSurfaceVariant,
                  height: 1.35,
                ),
              ),
            ),
            if (open)
              Container(
                margin: const EdgeInsets.only(top: 4),
                padding: const EdgeInsets.only(left: 12),
                decoration: BoxDecoration(
                  border: Border(
                    left: BorderSide(color: colors.outlineVariant, width: 2),
                  ),
                ),
                child: Text(
                  widget.item.text,
                  style: AppTypography.mono(
                    fontSize: AppTypography.systemMessageFontSize,
                    color: colors.onSurfaceVariant,
                    height: 1.35,
                  ).copyWith(fontStyle: FontStyle.italic),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _ToolRow extends StatelessWidget {
  const _ToolRow({required this.item, required this.displayMode});

  final TranscriptToolItem item;
  final ToolDisplayMode displayMode;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final failed = item.result?.isError == true;
    final kind = _toolActivityKind(item.name);
    final filename = switch (kind) {
      _ToolActivityKind.read ||
      _ToolActivityKind.search ||
      _ToolActivityKind.edit => transcriptEditFileName(item.input),
      _ => null,
    };
    final label = _toolActivityLabel(context, kind);
    final simpleActivity = filename == null ? label : '$label · $filename';
    final command = transcriptToolSummary(item.input, name: item.name);
    final operation = item.name?.trim().isNotEmpty == true
        ? item.name!
        : 'Tool';
    final activity = displayMode == ToolDisplayMode.simple
        ? simpleActivity
        : command.isEmpty
        ? operation
        : '$operation $command';
    return Align(
      alignment: Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.85,
        ),
        child: InkWell(
          key: Key('transcript-tool-${item.key}'),
          onTap: () => showToolDetailsBottomSheet(context: context, item: item),
          borderRadius: BorderRadius.circular(4),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 3, vertical: 2),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  _toolActivityIcon(kind),
                  size: 13,
                  color: failed
                      ? colors.error
                      : item.result == null
                      ? colors.tertiary
                      : colors.primary,
                ),
                const SizedBox(width: 6),
                Flexible(
                  child: Text(
                    activity,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppTypography.mono(
                      fontSize: AppTypography.systemMessageFontSize,
                      color: failed ? colors.error : colors.onSurfaceVariant,
                      height: 1.4,
                    ),
                  ),
                ),
                if (failed) ...[
                  const SizedBox(width: 4),
                  Text(
                    '· ${_toolActivityFailedLabel(context)}',
                    style: AppTypography.mono(
                      fontSize: AppTypography.systemMessageFontSize,
                      color: colors.error,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

enum _ToolActivityKind { read, search, web, edit, analysis, command, generic }

_ToolActivityKind _toolActivityKind(String? name) =>
    switch (name?.trim().toLowerCase()) {
      'read' => _ToolActivityKind.read,
      'grep' || 'glob' => _ToolActivityKind.search,
      'webfetch' || 'websearch' => _ToolActivityKind.web,
      'edit' || 'write' || 'notebookedit' => _ToolActivityKind.edit,
      'task' || 'agent' => _ToolActivityKind.analysis,
      'bash' => _ToolActivityKind.command,
      _ => _ToolActivityKind.generic,
    };

String _toolActivityLabel(BuildContext context, _ToolActivityKind kind) =>
    switch ((
      Localizations.of<AppLocalizations>(context, AppLocalizations),
      kind,
    )) {
      (final l10n?, _ToolActivityKind.read) => l10n.toolActivityRead,
      (final l10n?, _ToolActivityKind.search) => l10n.toolActivitySearch,
      (final l10n?, _ToolActivityKind.web) => l10n.toolActivityWeb,
      (final l10n?, _ToolActivityKind.edit) => l10n.toolActivityEdit,
      (final l10n?, _ToolActivityKind.analysis) => l10n.toolActivityAnalysis,
      (final l10n?, _ToolActivityKind.command) => l10n.toolActivityCommand,
      (final l10n?, _ToolActivityKind.generic) => l10n.toolActivityGeneric,
      (_, _ToolActivityKind.read) => 'Opened a file',
      (_, _ToolActivityKind.search) => 'Searched the materials',
      (_, _ToolActivityKind.web) => 'Checked external sources',
      (_, _ToolActivityKind.edit) => 'Updated a file',
      (_, _ToolActivityKind.analysis) => 'Performed additional analysis',
      (_, _ToolActivityKind.command) => 'Performed a technical operation',
      (_, _ToolActivityKind.generic) => 'Performed an action',
    };

String _toolActivityFailedLabel(BuildContext context) =>
    Localizations.of<AppLocalizations>(
      context,
      AppLocalizations,
    )?.toolActivityFailedShort ??
    'failed';

IconData _toolActivityIcon(_ToolActivityKind kind) => switch (kind) {
  _ToolActivityKind.read => LucideIcons.fileText,
  _ToolActivityKind.search => LucideIcons.search,
  _ToolActivityKind.web => LucideIcons.globe2,
  _ToolActivityKind.edit => LucideIcons.filePenLine,
  _ToolActivityKind.analysis => LucideIcons.bot,
  _ToolActivityKind.command => LucideIcons.terminal,
  _ToolActivityKind.generic => LucideIcons.wrench,
};

class _ActionResult extends StatefulWidget {
  const _ActionResult({required this.item});

  final TranscriptLooseItem item;

  @override
  State<_ActionResult> createState() => _ActionResultState();
}

class _ActionResultState extends State<_ActionResult> {
  bool open = false;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final long = widget.item.text.length > 300;
    final shown = open || !long
        ? widget.item.text
        : '${widget.item.text.substring(0, 300)}…';
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.85,
        ),
        padding: const EdgeInsets.only(left: 12),
        decoration: BoxDecoration(
          border: Border(
            left: BorderSide(color: colors.outlineVariant, width: 2),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              shown,
              style: AppTypography.monoCode(
                color: colors.onSurfaceVariant,
                height: 1.4,
              ).copyWith(fontSize: 11),
            ),
            if (long)
              InkWell(
                onTap: () => setState(() => open = !open),
                child: Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    open ? 'Less' : 'More',
                    style: AppTypography.monoCode(
                      color: colors.primary,
                    ).copyWith(fontSize: 11),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.item});

  final TranscriptNoticeItem item;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Text(
      item.text,
      style: AppTypography.mono(
        fontSize: AppTypography.systemMessageFontSize,
        color: item.isError ? colors.error : colors.onSurfaceVariant,
      ),
    );
  }
}

class _PreviewCard extends StatelessWidget {
  const _PreviewCard({required this.item, required this.onOpen});

  final TranscriptPreviewItem item;
  final ValueChanged<TranscriptPreviewItem>? onOpen;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final filename = item.path.replaceAll('\\', '/').split('/').last;
    final timestamp = formatActivityTimestamp(item.createdAt);
    return Align(
      alignment: Alignment.centerLeft,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          key: Key('transcript-preview-${item.key}'),
          onTap: onOpen == null ? null : () => onOpen!(item),
          borderRadius: BorderRadius.circular(6),
          child: Container(
            constraints: BoxConstraints(
              maxWidth: MediaQuery.sizeOf(context).width * 0.85,
            ),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
            decoration: BoxDecoration(
              color: colors.primaryContainer.withValues(alpha: 0.45),
              border: Border.all(color: colors.primary.withValues(alpha: 0.45)),
              borderRadius: BorderRadius.circular(6),
            ),
            child: Row(
              children: [
                Icon(LucideIcons.image, size: 15, color: colors.primary),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        filename,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppTypography.monoCode(color: colors.onSurface),
                      ),
                      if (item.author != null || timestamp != null)
                        Text(
                          [?item.author, ?timestamp].join(' · '),
                          style: AppTypography.body(
                            fontSize: 10,
                            color: colors.onSurfaceVariant,
                          ),
                        ),
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
}

class _RawText extends StatelessWidget {
  const _RawText({required this.item});

  final TranscriptRawItem item;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Text(
      item.text,
      style: AppTypography.monoCode(
        color: colors.onSurfaceVariant,
        height: 1.4,
      ).copyWith(fontSize: 11),
    );
  }
}

bool _isOwnMessage(TranscriptUserItem item, OperatorIdentity? operator) {
  if (operator == null) return true;
  final current = [
    operator.email,
    operator.githubLogin,
  ].whereType<String>().map((value) => value.toLowerCase()).toSet();
  return [
    item.authorEmail,
    item.authorGithubLogin,
    item.author,
  ].whereType<String>().any((value) => current.contains(value.toLowerCase()));
}

String _attachmentMeta(TranscriptAttachment attachment) {
  final extension = attachment.label.contains('.')
      ? attachment.label.split('.').last.toUpperCase()
      : null;
  final kind = extension ?? (attachment.type == 'image' ? 'IMAGE' : 'FILE');
  final bytes = attachment.size;
  if (bytes == null || bytes < 1) return kind;
  const units = ['B', 'KB', 'MB', 'GB'];
  var size = bytes.toDouble();
  var unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  final value = unit == 0 || size >= 10
      ? size.round().toString()
      : size.toStringAsFixed(1);
  return '$kind · $value ${units[unit]}';
}
