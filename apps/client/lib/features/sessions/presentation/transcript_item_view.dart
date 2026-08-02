import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../shared/design/colors.dart';
import '../../../shared/design/typography.dart';
import '../../../shared/formatters/activity_timestamp.dart';
import '../../../shared/widgets/app_markdown.dart';
import '../../auth/domain/auth_models.dart';
import 'tool_details_bottom_sheet.dart';
import 'transcript_items.dart';

class TranscriptItemView extends StatelessWidget {
  const TranscriptItemView({
    super.key,
    required this.item,
    this.operator,
    this.onOpenAttachment,
    this.onOpenPreview,
    this.onOpenLink,
  });

  final TranscriptItem item;
  final OperatorIdentity? operator;
  final ValueChanged<TranscriptAttachment>? onOpenAttachment;
  final ValueChanged<TranscriptPreviewItem>? onOpenPreview;
  final ValueChanged<String>? onOpenLink;

  @override
  Widget build(BuildContext context) {
    return switch (item) {
      TranscriptUserItem user => _UserBubble(
        item: user,
        operator: operator,
        onOpenAttachment: onOpenAttachment,
        onOpenLink: onOpenLink,
      ),
      TranscriptTextItem text => _AssistantText(
        item: text,
        onOpenLink: onOpenLink,
      ),
      TranscriptThinkingItem thinking => _ThinkingRow(item: thinking),
      TranscriptToolItem tool => _ToolRow(item: tool),
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
  });

  final TranscriptUserItem item;
  final OperatorIdentity? operator;
  final ValueChanged<TranscriptAttachment>? onOpenAttachment;
  final ValueChanged<String>? onOpenLink;

  @override
  Widget build(BuildContext context) {
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
                color: mine ? AppColors.forgeDeep : AppColors.iron950,
                border: mine ? null : Border.all(color: AppColors.iron800),
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
                            color: AppColors.felBright,
                            height: 1.15,
                          ),
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
                            ),
                          ),
                          if (timestamp != null) ...[
                            const SizedBox(width: 12),
                            _Timestamp(text: timestamp, mine: mine),
                          ],
                        ],
                      )
                    else if (item.text.isNotEmpty)
                      _UserText(text: item.text, onOpenLink: onOpenLink),
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
  const _UserText({required this.text, required this.onOpenLink});

  final String text;
  final ValueChanged<String>? onOpenLink;

  @override
  Widget build(BuildContext context) {
    return AppMarkdown(
      data: text,
      onTapLink: onOpenLink,
      textStyle: AppTypography.chatMessage(color: AppColors.bone, height: 1.35),
    );
  }
}

class _Timestamp extends StatelessWidget {
  const _Timestamp({required this.text, required this.mine});

  final String text;
  final bool mine;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: AppTypography.body(
        fontSize: 10,
        color: mine
            ? AppColors.bone.withValues(alpha: 0.6)
            : AppColors.boneFaint,
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
    final initial = label.trim().isEmpty ? '?' : label.trim()[0].toUpperCase();
    return Container(
      width: 28,
      height: 28,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: AppColors.fel.withValues(alpha: 0.15),
        border: Border.all(color: AppColors.fel.withValues(alpha: 0.35)),
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
    return Text(
      initial,
      style: AppTypography.body(
        fontSize: 11,
        fontWeight: FontWeight.w700,
        color: AppColors.felBright,
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
    return Material(
      color: mine
          ? AppColors.iron950.withValues(alpha: 0.25)
          : AppColors.rowSurface,
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
                      ? AppColors.bone.withValues(alpha: 0.1)
                      : AppColors.forge.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Icon(
                  attachment.type == 'image'
                      ? LucideIcons.image
                      : LucideIcons.paperclip,
                  size: 14,
                  color: mine
                      ? AppColors.bone.withValues(alpha: 0.8)
                      : AppColors.forge,
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
                            ? AppColors.bone.withValues(alpha: 0.55)
                            : AppColors.boneFaint,
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
  const _AssistantText({required this.item, required this.onOpenLink});

  final TranscriptTextItem item;
  final ValueChanged<String>? onOpenLink;

  @override
  Widget build(BuildContext context) {
    final timestamp = formatActivityTimestamp(item.createdAt);
    return Column(
      key: Key('transcript-text-${item.key}'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        AppMarkdown(
          key: Key('transcript-markdown-${item.key}'),
          data: item.text,
          onTapLink: onOpenLink,
          textStyle: AppTypography.chatMessage(
            color: AppColors.bone,
            height: 1.55,
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
                      color: AppColors.boneFaint,
                    ),
                  ),
                if (timestamp != null && item.resultMeta != null)
                  Text(
                    '·',
                    style: AppTypography.body(
                      fontSize: 10,
                      color: AppColors.boneFaint,
                    ),
                  ),
                if (item.resultMeta case final meta?)
                  Text(
                    meta.text,
                    key: Key('transcript-result-${item.key}'),
                    style: AppTypography.body(
                      fontSize: 10,
                      color: meta.isError
                          ? AppColors.blood
                          : AppColors.boneFaint,
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
  const _ThinkingRow({required this.item});

  final TranscriptThinkingItem item;

  @override
  State<_ThinkingRow> createState() => _ThinkingRowState();
}

class _ThinkingRowState extends State<_ThinkingRow> {
  bool open = false;

  @override
  Widget build(BuildContext context) {
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
                '✦ ${_thinkingLabel(widget.item.text)} ${open ? '▾' : '▸'}',
                style: AppTypography.mono(
                  fontSize: AppTypography.systemMessageFontSize,
                  color: AppColors.boneFaint,
                  height: 1.35,
                ),
              ),
            ),
            if (open)
              Container(
                margin: const EdgeInsets.only(top: 4),
                padding: const EdgeInsets.only(left: 12),
                decoration: const BoxDecoration(
                  border: Border(
                    left: BorderSide(color: AppColors.iron800, width: 2),
                  ),
                ),
                child: Text(
                  widget.item.text,
                  style: AppTypography.mono(
                    fontSize: AppTypography.systemMessageFontSize,
                    color: AppColors.boneFaint,
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
  const _ToolRow({required this.item});

  final TranscriptToolItem item;

  @override
  Widget build(BuildContext context) {
    final failed = item.result?.isError == true;
    final operation = item.name?.trim().toLowerCase() == 'edit'
        ? transcriptEditOperation(item.input)
        : null;
    final stats = operation == null ? null : transcriptEditStats(item.input);
    final label = operation == null
        ? item.name ?? 'Tool'
        : switch (operation) {
            TranscriptEditOperation.create => 'Create',
            TranscriptEditOperation.edit => 'Edit',
            TranscriptEditOperation.delete => 'Delete',
          };
    final summary = transcriptToolSummary(item.input, name: item.name);
    return Align(
      alignment: Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.85,
        ),
        child: Padding(
          key: Key('transcript-tool-${item.key}'),
          padding: const EdgeInsets.symmetric(vertical: 2),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                switch (operation) {
                  TranscriptEditOperation.create => LucideIcons.filePlus,
                  TranscriptEditOperation.delete => LucideIcons.fileX,
                  TranscriptEditOperation.edit => LucideIcons.pencil,
                  null => LucideIcons.terminal,
                },
                size: 11,
                color: failed ? AppColors.blood : AppColors.felBright,
              ),
              const SizedBox(width: 4),
              Text(
                label,
                style: AppTypography.monoCode(
                  color: failed ? AppColors.blood : AppColors.felBright,
                ).copyWith(fontSize: 11),
              ),
              if (operation != null && stats != null) ...[
                const SizedBox(width: 3),
                _EditStats(operation: operation, stats: stats),
              ],
              if (summary.isNotEmpty) ...[
                const SizedBox(width: 5),
                Flexible(
                  child: Text(
                    summary,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppTypography.monoCode(
                      color: failed ? AppColors.blood : AppColors.boneFaint,
                    ).copyWith(fontSize: 11),
                  ),
                ),
              ],
              const SizedBox(width: 6),
              InkWell(
                key: Key('transcript-tool-details-${item.key}'),
                onTap: () =>
                    showToolDetailsBottomSheet(context: context, item: item),
                borderRadius: BorderRadius.circular(3),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 3),
                  child: Text(
                    'Details',
                    style: AppTypography.monoCode(color: AppColors.boneFaint)
                        .copyWith(
                          fontSize: 11,
                          decoration: TextDecoration.underline,
                          decorationStyle: TextDecorationStyle.dotted,
                          decorationColor: AppColors.boneFaint,
                          decorationThickness: 1,
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

class _EditStats extends StatelessWidget {
  const _EditStats({required this.operation, required this.stats});

  final TranscriptEditOperation operation;
  final TranscriptEditStats stats;

  @override
  Widget build(BuildContext context) {
    final base = AppTypography.monoCode(
      color: AppColors.boneFaint,
    ).copyWith(fontSize: 11);
    return Text.rich(
      TextSpan(
        style: base,
        children: [
          const TextSpan(text: '('),
          if (operation != TranscriptEditOperation.delete)
            TextSpan(
              text: '+${stats.added}',
              style: base.copyWith(color: AppColors.felBright),
            ),
          if (operation == TranscriptEditOperation.edit)
            const TextSpan(text: ','),
          if (operation != TranscriptEditOperation.create)
            TextSpan(
              text: '−${stats.removed}',
              style: base.copyWith(color: AppColors.blood),
            ),
          const TextSpan(text: ')'),
        ],
      ),
    );
  }
}

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
        decoration: const BoxDecoration(
          border: Border(left: BorderSide(color: AppColors.iron700, width: 2)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              shown,
              style: AppTypography.monoCode(
                color: AppColors.boneFaint,
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
                      color: AppColors.boneDim,
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
    return Text(
      item.text,
      style: AppTypography.mono(
        fontSize: AppTypography.systemMessageFontSize,
        color: item.isError ? AppColors.blood : AppColors.boneFaint,
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
              color: AppColors.fel.withValues(alpha: 0.07),
              border: Border.all(
                color: AppColors.felDeep.withValues(alpha: 0.5),
              ),
              borderRadius: BorderRadius.circular(6),
            ),
            child: Row(
              children: [
                const Icon(
                  LucideIcons.image,
                  size: 15,
                  color: AppColors.felBright,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        filename,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppTypography.monoCode(color: AppColors.bone),
                      ),
                      if (item.author != null || timestamp != null)
                        Text(
                          [?item.author, ?timestamp].join(' · '),
                          style: AppTypography.body(
                            fontSize: 10,
                            color: AppColors.boneFaint,
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
    return Text(
      item.text,
      style: AppTypography.monoCode(
        color: AppColors.boneFaint,
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

String _thinkingLabel(String seed) {
  const labels = [
    'Work work!',
    'WAAAGH in progress!',
    'Berserker focus mode!',
    'Hacking the battle plans!',
    'Stomping through logic!',
    'Forging the next swing!',
    'Teeth on the byte-grind!',
    'Crushing bugs like chitin!',
    'Axes sharpened, output incoming!',
    'Grunts are thinking, quietly!',
    'Orcish focus…',
  ];
  var hash = 0;
  for (final code in seed.codeUnits) {
    hash = (31 * hash + code) & 0x7fffffff;
  }
  return labels[hash % labels.length];
}
