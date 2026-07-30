import 'dart:convert';

import 'package:flutter/material.dart';

import '../../../shared/design/colors.dart';
import '../../../shared/design/typography.dart';
import '../../../shared/widgets/app_bottom_sheet.dart';
import 'transcript_items.dart';

Future<void> showToolDetailsBottomSheet({
  required BuildContext context,
  required TranscriptToolItem item,
}) {
  final isEdit = !transcriptToolHasOutputSection(item.name);
  final stats = isEdit ? transcriptEditStats(item.input) : null;
  final diff = isEdit ? transcriptEditDiff(item.input) : null;
  final title = isEdit
      ? transcriptEditFileName(item.input) ?? item.name ?? 'Tool'
      : item.name ?? 'Tool';
  return showAppBottomSheet<void>(
    context: context,
    builder: (context) => FractionallySizedBox(
      heightFactor: 0.86,
      child: AppBottomSheet(
        title: title,
        trailing: stats == null ? null : _DetailStats(stats: stats),
        children: [
          Expanded(
            child: ListView(
              key: const Key('tool-details-content'),
              padding: const EdgeInsets.fromLTRB(0, 2, 0, 4),
              children: [
                if (diff != null)
                  _DiffPanel(lines: diff)
                else
                  _DetailSection(
                    title: 'COMMAND',
                    marker: '›_',
                    markerColor: AppColors.felBright,
                    text: _inputText(item, isEdit: isEdit),
                  ),
                if (transcriptToolHasOutputSection(item.name)) ...[
                  const SizedBox(height: 12),
                  _DetailSection(
                    title: 'OUTPUT',
                    marker: '↳',
                    markerColor: item.result?.isError == true
                        ? AppColors.blood
                        : AppColors.forge,
                    text: _outputText(item.result),
                    error: item.result?.isError == true,
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

String _inputText(TranscriptToolItem item, {required bool isEdit}) {
  final command = transcriptToolSummary(item.input, name: item.name);
  if (!isEdit) return command.isEmpty ? '—' : command;
  if (item.input case final Map input) {
    final patch = input['patch'] ?? input['diff'];
    if (patch is String && patch.trim().isNotEmpty) return patch;
    try {
      return const JsonEncoder.withIndent('  ').convert(input);
    } on JsonUnsupportedObjectError {
      // Fall through to the compact command when a tool supplied odd values.
    }
  }
  return command.isEmpty ? '—' : command;
}

String _outputText(TranscriptToolResult? result) {
  final text = result?.text.trim() ?? '';
  if (text.isEmpty) return 'No output';
  if (result?.isError == true) return result!.text;
  if (!(text.startsWith('{') || text.startsWith('['))) return result!.text;
  try {
    final decoded = jsonDecode(text);
    if (decoded is Map || decoded is List) {
      return const JsonEncoder.withIndent('  ').convert(decoded);
    }
  } on FormatException {
    // Ordinary output is rendered exactly as received.
  }
  return result!.text;
}

class _DetailStats extends StatelessWidget {
  const _DetailStats({required this.stats});

  final TranscriptEditStats stats;

  @override
  Widget build(BuildContext context) {
    final base = AppTypography.monoCode(color: AppColors.boneFaint);
    return Text.rich(
      key: const Key('tool-details-stats'),
      TextSpan(
        style: base,
        children: [
          const TextSpan(text: '('),
          TextSpan(
            text: '−${stats.removed}',
            style: base.copyWith(color: AppColors.blood),
          ),
          const TextSpan(text: ','),
          TextSpan(
            text: '+${stats.added}',
            style: base.copyWith(color: AppColors.felBright),
          ),
          const TextSpan(text: ')'),
        ],
      ),
    );
  }
}

class _DetailSection extends StatelessWidget {
  const _DetailSection({
    required this.title,
    required this.marker,
    required this.markerColor,
    required this.text,
    this.error = false,
  });

  final String title;
  final String marker;
  final Color markerColor;
  final String text;
  final bool error;

  @override
  Widget build(BuildContext context) {
    return Container(
      key: Key('tool-details-${title.toLowerCase()}'),
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: AppColors.iron950,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: error
              ? AppColors.blood.withValues(alpha: 0.35)
              : AppColors.iron800,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: const BoxDecoration(
              color: AppColors.iron900,
              border: Border(bottom: BorderSide(color: AppColors.iron800)),
            ),
            child: Row(
              children: [
                Text(
                  marker,
                  style: AppTypography.monoCode(
                    color: markerColor,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  title,
                  style: AppTypography.display(
                    fontSize: 10,
                    fontWeight: FontWeight.w600,
                    color: AppColors.boneDim,
                    letterSpacing: 1.8,
                  ),
                ),
              ],
            ),
          ),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 260),
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(14),
              child: SelectableText(
                text,
                style: AppTypography.monoCode(
                  color: error ? AppColors.blood : AppColors.boneDim,
                  height: 1.5,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _DiffPanel extends StatelessWidget {
  const _DiffPanel({required this.lines});

  final List<TranscriptDiffLine> lines;

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * 0.62,
      ),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: AppColors.iron950,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: AppColors.iron800),
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(10),
          child: ListView.builder(
            key: const Key('tool-details-diff'),
            itemCount: lines.length,
            itemBuilder: (context, index) =>
                _DiffRow(line: lines[index], index: index),
          ),
        ),
      ),
    );
  }
}

class _DiffRow extends StatelessWidget {
  const _DiffRow({required this.line, required this.index});

  final TranscriptDiffLine line;
  final int index;

  @override
  Widget build(BuildContext context) {
    final (marker, foreground, background) = switch (line.kind) {
      TranscriptDiffLineKind.add => (
        '+',
        AppColors.felBright,
        AppColors.fel.withValues(alpha: 0.15),
      ),
      TranscriptDiffLineKind.remove => (
        '−',
        AppColors.blood,
        AppColors.blood.withValues(alpha: 0.15),
      ),
      TranscriptDiffLineKind.context => (
        ' ',
        AppColors.boneDim,
        Colors.transparent,
      ),
    };
    final lineNumberStyle = AppTypography.monoCode(
      color: AppColors.boneFaint,
    );
    return ColoredBox(
      key: Key('tool-details-diff-line-$index'),
      color: background,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 18,
              child: Text(
                marker,
                textAlign: TextAlign.center,
                style: AppTypography.monoCode(
                  color: foreground,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            SizedBox(
              width: 30,
              child: Text(
                line.oldLine?.toString() ?? '',
                textAlign: TextAlign.right,
                style: lineNumberStyle,
              ),
            ),
            const SizedBox(width: 8),
            SizedBox(
              width: 30,
              child: Text(
                line.newLine?.toString() ?? '',
                textAlign: TextAlign.right,
                style: lineNumberStyle,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: SelectableText(
                line.text.isEmpty ? ' ' : line.text,
                style: AppTypography.monoCode(
                  color: foreground,
                  height: 1.35,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
