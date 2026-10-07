import '../domain/session_models.dart';

sealed class TranscriptItem {
  const TranscriptItem({required this.key});

  final String key;
  bool get isUser => false;
}

class TranscriptUserItem extends TranscriptItem {
  const TranscriptUserItem({
    required super.key,
    required this.text,
    this.sourceEventId,
    this.replyTo,
    this.author,
    this.authorEmail,
    this.authorGithubLogin,
    this.authorAvatarUrl,
    this.attachments = const [],
    this.createdAt,
  });

  final String text;
  final String? sourceEventId;
  final SelectedTextReply? replyTo;
  final String? author;
  final String? authorEmail;
  final String? authorGithubLogin;
  final String? authorAvatarUrl;
  final List<TranscriptAttachment> attachments;
  final double? createdAt;

  @override
  bool get isUser => true;
}

class TranscriptTextItem extends TranscriptItem {
  TranscriptTextItem({
    required super.key,
    required this.text,
    this.sourceEventId,
    this.createdAt,
    this.resultMeta,
  });

  final String text;
  final String? sourceEventId;
  final double? createdAt;
  TranscriptResultMeta? resultMeta;
}

class TranscriptThinkingItem extends TranscriptItem {
  const TranscriptThinkingItem({required super.key, required this.text});

  final String text;
}

class TranscriptToolItem extends TranscriptItem {
  const TranscriptToolItem({
    required super.key,
    this.name,
    this.input,
    this.result,
  });

  final String? name;
  final Object? input;
  final TranscriptToolResult? result;

  TranscriptToolItem copyWith({TranscriptToolResult? result}) {
    return TranscriptToolItem(
      key: key,
      name: name,
      input: input,
      result: result ?? this.result,
    );
  }
}

class TranscriptLooseItem extends TranscriptItem {
  const TranscriptLooseItem({required super.key, required this.text});

  final String text;
}

class TranscriptNoticeItem extends TranscriptItem {
  const TranscriptNoticeItem({
    required super.key,
    required this.text,
    this.isError = false,
  });

  final String text;
  final bool isError;
}

class TranscriptPreviewItem extends TranscriptItem {
  const TranscriptPreviewItem({
    required super.key,
    required this.path,
    this.author,
    this.createdAt,
  });

  final String path;
  final String? author;
  final double? createdAt;
}

class TranscriptRawItem extends TranscriptItem {
  const TranscriptRawItem({required super.key, required this.text});

  final String text;
}

class TranscriptAttachment {
  const TranscriptAttachment({
    required this.type,
    required this.path,
    required this.name,
    this.size,
  });

  final String? type;
  final String? path;
  final String? name;
  final int? size;

  String get label {
    final explicit = name?.trim();
    if (explicit?.isNotEmpty == true) return explicit!;
    final source = path?.replaceAll('\\', '/').split('/').last.trim();
    return source?.isNotEmpty == true ? source! : 'attachment';
  }
}

class TranscriptToolResult {
  const TranscriptToolResult({required this.text, required this.isError});

  final String text;
  final bool isError;
}

// Only a successful result annotates the message it belongs to; a failure is
// its own notice row, so this never needs an error tone.
class TranscriptResultMeta {
  const TranscriptResultMeta({required this.text});

  final String text;
}

double transcriptItemGap(TranscriptItem? previous, TranscriptItem item) {
  if (previous == null) return 0;
  if (previous.isUser && item.isUser) return 4;
  if (previous.isUser != item.isUser) return 24;
  if (previous is TranscriptTextItem || item is TranscriptTextItem) return 16;
  return 2;
}

double transcriptWorkingGap(
  TranscriptItem? previous, {
  bool afterGhost = false,
}) {
  if (previous == null && !afterGhost) return 0;
  if (afterGhost || previous?.isUser == true) return 24;
  return 16;
}

class TranscriptWorkingActivity {
  const TranscriptWorkingActivity({required this.label, this.startedAt});

  final String label;
  final double? startedAt;
}

TranscriptWorkingActivity transcriptWorkingActivity(
  TranscriptEvent? event, {
  required String fallbackLabel,
}) {
  final startedAt = event?.createdAt;
  if (event?.type == 'assistant') {
    final blocks = _messageBlocks(event!.payload);
    for (final block in blocks.reversed) {
      if (block['type'] == 'tool_use') {
        final name = _string(block['name']);
        return TranscriptWorkingActivity(
          label: switch (name) {
            'Bash' => 'Running a command…',
            'Read' => 'Reading a file…',
            'Edit' || 'Write' || 'NotebookEdit' => 'Editing files…',
            'Grep' || 'Glob' => 'Searching the code…',
            'WebFetch' || 'WebSearch' => 'Searching the web…',
            'Task' || 'Agent' => 'Running a sub-agent…',
            _ => 'Working: ${name ?? 'tool'}…',
          },
          startedAt: startedAt,
        );
      }
      if (block['type'] == 'text' &&
          _string(block['text'])?.trim().isNotEmpty == true) {
        return TranscriptWorkingActivity(
          label: 'Agent is writing…',
          startedAt: startedAt,
        );
      }
    }
  }
  return TranscriptWorkingActivity(label: fallbackLabel, startedAt: startedAt);
}

enum TranscriptEditOperation { create, edit, delete }

class TranscriptEditStats {
  const TranscriptEditStats({required this.added, required this.removed});

  final int added;
  final int removed;
}

enum TranscriptDiffLineKind { context, remove, add }

class TranscriptDiffLine {
  const TranscriptDiffLine({
    required this.kind,
    required this.text,
    this.oldLine,
    this.newLine,
  });

  final TranscriptDiffLineKind kind;
  final String text;
  final int? oldLine;
  final int? newLine;
}

List<TranscriptItem> flattenTranscriptEvents(List<TranscriptEvent> events) {
  final items = <TranscriptItem>[];
  final toolIndexes = <String, int>{};

  for (var eventIndex = 0; eventIndex < events.length; eventIndex++) {
    final event = events[eventIndex];
    final payload = event.payload;
    final baseKey = event.eventId;

    switch (event.type) {
      case 'user_message':
        items.add(
          TranscriptUserItem(
            key: baseKey,
            sourceEventId: event.eventId,
            replyTo: event.replyTo,
            text: _string(payload['text']) ?? '',
            author: _string(payload['author']),
            authorEmail: _string(payload['authorEmail']),
            authorGithubLogin: _string(payload['authorGithubLogin']),
            authorAvatarUrl: _string(payload['authorAvatarUrl']),
            attachments: _attachments(payload['attachments']),
            createdAt: event.createdAt,
          ),
        );
        continue;
      case 'assistant':
        final blocks = _messageBlocks(payload);
        for (var blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
          final block = blocks[blockIndex];
          final key = '$baseKey-$blockIndex';
          switch (_string(block['type'])) {
            case 'text':
              final text = _string(block['text']);
              if (text?.trim().isNotEmpty == true) {
                items.add(
                  TranscriptTextItem(
                    key: key,
                    sourceEventId: event.eventId,
                    text: text!,
                    createdAt: event.createdAt,
                  ),
                );
              }
              break;
            case 'thinking':
              final text = _string(block['thinking']);
              if (text?.trim().isNotEmpty == true) {
                items.add(TranscriptThinkingItem(key: key, text: text!));
              }
              break;
            case 'tool_use':
              items.add(
                TranscriptToolItem(
                  key: key,
                  name: _string(block['name']),
                  input: block['input'],
                ),
              );
              final id = _string(block['id']);
              if (id != null) toolIndexes[id] = items.length - 1;
              break;
          }
        }
        continue;
      case 'user':
        final blocks = _messageBlocks(payload);
        for (var blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
          final block = blocks[blockIndex];
          final key = '$baseKey-$blockIndex';
          if (block['type'] == 'tool_result') {
            final result = TranscriptToolResult(
              text: textFromTranscriptContent(block['content']),
              isError: block['is_error'] == true,
            );
            final index = toolIndexes[_string(block['tool_use_id'])];
            if (index != null && items[index] is TranscriptToolItem) {
              items[index] = (items[index] as TranscriptToolItem).copyWith(
                result: result,
              );
            } else {
              items.add(TranscriptToolItem(key: key, result: result));
            }
          } else if (block['type'] == 'text') {
            final text = _string(block['text']);
            if (text?.isNotEmpty == true) {
              items.add(TranscriptLooseItem(key: key, text: text!));
            }
          }
        }
        continue;
      case 'system':
      case 'rate_limit_event':
        continue;
      case 'result':
        final parts = <String>[];
        final duration = _number(payload['duration_ms']);
        final turns = _number(payload['num_turns'])?.round();
        final usage = payload['usage'];
        final output = usage is Map
            ? _number(usage['output_tokens'])?.round() ?? 0
            : 0;
        if (duration != null) parts.add('${(duration / 1000).round()}s');
        if (turns != null) parts.add('$turns ${turns == 1 ? 'turn' : 'turns'}');
        if (output > 0) parts.add('${compactTranscriptNumber(output)} output');
        // A failed turn says why it failed and stands on its own line. Folded
        // into the previous bubble's metadata it read as a bare red duration,
        // indistinguishable from a turn that simply took ten seconds.
        if (payload['is_error'] == true) {
          final reason = transcriptResultFailureReason(payload);
          final retry = _number(payload['retry_scheduled'])?.round();
          items.add(
            TranscriptNoticeItem(
              key: baseKey,
              text: [
                if (reason.isNotEmpty) reason,
                ...parts,
                if (retry != null)
                  'retrying $retry/${_number(payload['retry_max'])?.round() ?? retry}',
              ].join(' · '),
              isError: true,
            ),
          );
          continue;
        }
        if (parts.isNotEmpty) {
          final meta = TranscriptResultMeta(text: parts.join(' · '));
          TranscriptTextItem? lastText;
          for (var index = items.length - 1; index >= 0; index--) {
            final item = items[index];
            if (item is TranscriptUserItem) break;
            if (item is TranscriptTextItem) {
              lastText = item;
              break;
            }
          }
          if (lastText != null) {
            lastText.resultMeta = meta;
          } else {
            items.add(
              TranscriptNoticeItem(key: baseKey, text: meta.text),
            );
          }
        }
        continue;
      case 'preview':
        final path = _string(payload['path']);
        if (path?.isNotEmpty == true) {
          items.add(
            TranscriptPreviewItem(
              key: baseKey,
              path: path!,
              author: _string(payload['author']),
              createdAt: event.createdAt,
            ),
          );
        }
        continue;
      case '_raw':
        final text = _string(payload['text']);
        if (text?.isNotEmpty == true) {
          items.add(TranscriptRawItem(key: baseKey, text: text!));
        }
        continue;
      default:
        final text =
            _string(payload['text']) ??
            textFromTranscriptContent(payload['content']);
        if (text.isNotEmpty) {
          items.add(TranscriptRawItem(key: baseKey, text: text));
        }
        continue;
    }
  }

  return items;
}

// The human-readable half of a failed result event. Peon's own classification
// reads the same fields (`errors[]`, then `result`); a failure that carries
// neither is described by its subtype rather than by dumping the raw event,
// which is complete but unreadable in a chat bubble.
const _failureReasonMax = 300;

String transcriptResultFailureReason(Map<String, dynamic> payload) {
  final errors = payload['errors'];
  var raw = '';
  if (errors is List && errors.isNotEmpty) {
    raw = errors.map((error) => error.toString()).join('; ');
  } else if (_string(payload['result'])?.trim().isNotEmpty == true) {
    raw = _string(payload['result'])!;
  } else {
    final subtype = _string(payload['subtype']);
    if (subtype != null && subtype != 'success') raw = subtype;
  }
  final text = raw.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (text.length <= _failureReasonMax) return text;
  return '${text.substring(0, _failureReasonMax - 1)}…';
}

String textFromTranscriptContent(Object? content) {
  if (content is String) return content;
  if (content is! List) return '';
  return content
      .map((item) {
        if (item is String) return item;
        if (item is Map) return _string(item['text']) ?? '';
        return '';
      })
      .where((text) => text.isNotEmpty)
      .join('\n');
}

String transcriptToolSummary(Object? input, {String? name}) {
  if (input is! Map) return '';
  for (final key in const [
    'command',
    'file_path',
    'filePath',
    'path',
    'filename',
    'pattern',
    'url',
    'description',
    'prompt',
    'query',
  ]) {
    final value = _string(input[key]);
    if (value?.trim().isNotEmpty == true) return value!;
  }
  if (name?.trim().toLowerCase() == 'edit') {
    final changes = input['changes'];
    if (changes is List) {
      final paths = changes
          .whereType<Map>()
          .map((change) => _string(change['path']))
          .whereType<String>()
          .where((path) => path.trim().isNotEmpty)
          .toList();
      if (paths.length == 1) return paths.first;
      if (paths.length > 1) return '${paths.first} (+${paths.length - 1})';
    }
    final patch = _string(input['patch'] ?? input['diff']);
    if (patch?.isNotEmpty == true) {
      final match = RegExp(
        r'^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$',
        multiLine: true,
      ).firstMatch(patch!);
      return match?.group(1)?.trim() ?? patch.split('\n').first;
    }
  }
  return '';
}

bool transcriptToolHasOutputSection(String? name) {
  return name?.trim().toLowerCase() != 'edit';
}

String? transcriptEditFileName(Object? input) {
  if (input is! Map) return null;
  String? path;
  var additionalFiles = 0;
  for (final key in const ['file_path', 'filePath', 'path', 'filename']) {
    final candidate = _string(input[key])?.trim();
    if (candidate?.isNotEmpty == true) {
      path = candidate;
      break;
    }
  }

  final changes = input['changes'];
  if (path == null && changes is List) {
    final paths = changes
        .whereType<Map>()
        .map((change) => _string(change['path'])?.trim())
        .whereType<String>()
        .where((candidate) => candidate.isNotEmpty)
        .toList();
    if (paths.isNotEmpty) {
      path = paths.first;
      additionalFiles = paths.length - 1;
    }
  }

  if (path == null) {
    final patch = _string(input['patch'] ?? input['diff']);
    if (patch != null) {
      path =
          RegExp(
            r'^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$',
            multiLine: true,
          ).firstMatch(patch)?.group(1)?.trim() ??
          RegExp(
            r'^\+\+\+\s+(?:b/)?(.+)$',
            multiLine: true,
          ).firstMatch(patch)?.group(1)?.trim();
    }
  }

  if (path == null || path.isEmpty) return null;
  final segments = path.replaceAll(r'\', '/').split('/');
  final fileName = segments.where((segment) => segment.isNotEmpty).lastOrNull;
  final label = fileName ?? path;
  return additionalFiles == 0 ? label : '$label (+$additionalFiles)';
}

List<TranscriptDiffLine>? transcriptEditDiff(Object? input) {
  if (input is! Map) return null;
  final changes = input['changes'];
  if (changes is List) {
    final lines = <TranscriptDiffLine>[];
    for (final change in changes.whereType<Map>()) {
      final path = _string(change['path']) ?? 'changed file';
      final diff = _string(change['diff']);
      if (diff != null) {
        int? oldLine;
        int? newLine;
        for (final text in diff.split('\n')) {
          final hunk = RegExp(
            r'^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@',
          ).firstMatch(text);
          if (hunk != null) {
            oldLine = int.parse(hunk.group(1)!);
            newLine = int.parse(hunk.group(2)!);
            lines.add(
              TranscriptDiffLine(
                kind: TranscriptDiffLineKind.context,
                text: text,
              ),
            );
            continue;
          }
          final isHeader = text.startsWith('+++') || text.startsWith('---');
          final kind = !isHeader && text.startsWith('+')
              ? TranscriptDiffLineKind.add
              : !isHeader && text.startsWith('-')
              ? TranscriptDiffLineKind.remove
              : TranscriptDiffLineKind.context;
          final numbered = oldLine != null && newLine != null && !isHeader;
          lines.add(
            TranscriptDiffLine(
              kind: kind,
              text: kind == TranscriptDiffLineKind.context
                  ? text
                  : text.substring(1),
              oldLine: numbered && kind != TranscriptDiffLineKind.add
                  ? oldLine
                  : null,
              newLine: numbered && kind != TranscriptDiffLineKind.remove
                  ? newLine
                  : null,
            ),
          );
          if (numbered && kind != TranscriptDiffLineKind.add) {
            oldLine = oldLine + 1;
          }
          if (numbered && kind != TranscriptDiffLineKind.remove) {
            newLine = newLine + 1;
          }
        }
      }
      if (change['diffTruncated'] == true) {
        final bytes = change['diffOriginalBytes'];
        final suffix = bytes is num
            ? ' (${bytes.round()} bytes originally)'
            : '';
        lines.add(
          TranscriptDiffLine(
            kind: TranscriptDiffLineKind.context,
            text: '… diff truncated for $path$suffix',
          ),
        );
      }
      final unavailable = _string(change['diffUnavailable']);
      if (unavailable != null) {
        lines.add(
          TranscriptDiffLine(
            kind: TranscriptDiffLineKind.context,
            text: 'Diff unavailable for $path: $unavailable',
          ),
        );
      }
    }
    if (lines.isNotEmpty) return lines;
  }

  final oldText = _string(input['old_string']);
  final newText = _string(input['new_string']);
  if (oldText == null || newText == null) return null;
  return _diffText(oldText, newText);
}

List<TranscriptDiffLine> _diffText(String oldText, String newText) {
  final before = oldText.split('\n');
  final after = newText.split('\n');
  final lengths = List.generate(
    before.length + 1,
    (_) => List<int>.filled(after.length + 1, 0),
  );
  for (var oldIndex = before.length - 1; oldIndex >= 0; oldIndex--) {
    for (var newIndex = after.length - 1; newIndex >= 0; newIndex--) {
      lengths[oldIndex][newIndex] = before[oldIndex] == after[newIndex]
          ? lengths[oldIndex + 1][newIndex + 1] + 1
          : lengths[oldIndex + 1][newIndex] > lengths[oldIndex][newIndex + 1]
          ? lengths[oldIndex + 1][newIndex]
          : lengths[oldIndex][newIndex + 1];
    }
  }

  final lines = <TranscriptDiffLine>[];
  var oldIndex = 0;
  var newIndex = 0;
  while (oldIndex < before.length || newIndex < after.length) {
    if (oldIndex < before.length &&
        newIndex < after.length &&
        before[oldIndex] == after[newIndex]) {
      lines.add(
        TranscriptDiffLine(
          kind: TranscriptDiffLineKind.context,
          text: before[oldIndex],
          oldLine: oldIndex + 1,
          newLine: newIndex + 1,
        ),
      );
      oldIndex++;
      newIndex++;
    } else if (newIndex < after.length &&
        (oldIndex == before.length ||
            lengths[oldIndex][newIndex + 1] >=
                lengths[oldIndex + 1][newIndex])) {
      lines.add(
        TranscriptDiffLine(
          kind: TranscriptDiffLineKind.add,
          text: after[newIndex],
          newLine: newIndex + 1,
        ),
      );
      newIndex++;
    } else {
      lines.add(
        TranscriptDiffLine(
          kind: TranscriptDiffLineKind.remove,
          text: before[oldIndex],
          oldLine: oldIndex + 1,
        ),
      );
      oldIndex++;
    }
  }
  return lines;
}

TranscriptEditOperation transcriptEditOperation(Object? input) {
  if (input is! Map) return TranscriptEditOperation.edit;
  final changes = input['changes'];
  if (changes is List && changes.isNotEmpty) {
    final operations = changes.whereType<Map>().map((change) {
      final rawKind = change['kind'];
      final kind = rawKind is Map ? rawKind['type'] : rawKind;
      return switch (kind?.toString().trim().toLowerCase()) {
        'add' || 'create' || 'added' => TranscriptEditOperation.create,
        'delete' || 'remove' || 'deleted' => TranscriptEditOperation.delete,
        'update' || 'edit' || 'rename' => TranscriptEditOperation.edit,
        _ => null,
      };
    }).toList();
    if (operations.isNotEmpty &&
        operations.every(
          (operation) => operation == TranscriptEditOperation.create,
        )) {
      return TranscriptEditOperation.create;
    }
    if (operations.isNotEmpty &&
        operations.every(
          (operation) => operation == TranscriptEditOperation.delete,
        )) {
      return TranscriptEditOperation.delete;
    }
    if (operations.any((operation) => operation != null)) {
      return TranscriptEditOperation.edit;
    }
  }

  final patch = _string(input['patch'] ?? input['diff']);
  if (patch != null) {
    if (RegExp(r'^\*\*\* Add File:', multiLine: true).hasMatch(patch) ||
        RegExp(r'^---\s+/dev/null\s*$', multiLine: true).hasMatch(patch)) {
      return TranscriptEditOperation.create;
    }
    if (RegExp(r'^\*\*\* Delete File:', multiLine: true).hasMatch(patch) ||
        RegExp(r'^\+\+\+\s+/dev/null\s*$', multiLine: true).hasMatch(patch)) {
      return TranscriptEditOperation.delete;
    }
  }
  return TranscriptEditOperation.edit;
}

TranscriptEditStats? transcriptEditStats(Object? input) {
  if (input is! Map) return null;
  final operation = transcriptEditOperation(input);
  final changes = input['changes'];
  if (changes is List) {
    var added = 0;
    var removed = 0;
    var foundDiff = false;
    for (final change in changes.whereType<Map>()) {
      final diff = _string(change['diff']);
      if (diff == null) continue;
      foundDiff = true;
      final stats = _statsFromDiff(diff, operation);
      added += stats.added;
      removed += stats.removed;
    }
    if (foundDiff) {
      return TranscriptEditStats(added: added, removed: removed);
    }
  }

  final oldText = _string(input['old_string']);
  final newText = _string(input['new_string']);
  if (oldText != null && newText != null) {
    return TranscriptEditStats(
      added: _contentLineCount(newText),
      removed: _contentLineCount(oldText),
    );
  }

  final directDiff = _string(input['patch'] ?? input['diff']);
  return directDiff == null ? null : _statsFromDiff(directDiff, operation);
}

TranscriptEditStats _statsFromDiff(
  String diff,
  TranscriptEditOperation operation,
) {
  var added = 0;
  var removed = 0;
  final hunks = <({int oldLength, int newLength})>[];
  final lines = diff.split('\n');
  final hunkPattern = RegExp(
    r'^@@ -(?:\d+)(?:,(\d+))? \+(?:\d+)(?:,(\d+))? @@',
  );
  for (final line in lines) {
    final hunk = hunkPattern.firstMatch(line);
    if (hunk != null) {
      hunks.add((
        oldLength: int.tryParse(hunk.group(1) ?? '') ?? 1,
        newLength: int.tryParse(hunk.group(2) ?? '') ?? 1,
      ));
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  final patchLike =
      hunks.isNotEmpty ||
      lines.any(
        (line) => RegExp(r'^\*\*\* (?:Add|Delete|Update) File:').hasMatch(line),
      ) ||
      (lines.any(
            (line) => RegExp(r'^--- (?:/dev/null|[ab]/)').hasMatch(line),
          ) &&
          lines.any(
            (line) => RegExp(r'^\+\+\+ (?:/dev/null|[ab]/)').hasMatch(line),
          ));

  if (operation == TranscriptEditOperation.create && !patchLike) {
    return TranscriptEditStats(added: _contentLineCount(diff), removed: 0);
  }
  if (operation == TranscriptEditOperation.delete && !patchLike) {
    return TranscriptEditStats(added: 0, removed: _contentLineCount(diff));
  }
  if (operation == TranscriptEditOperation.create && added == 0) {
    added = hunks
        .where((hunk) => hunk.oldLength == 0)
        .fold(0, (count, hunk) => count + hunk.newLength);
  }
  if (operation == TranscriptEditOperation.delete && removed == 0) {
    removed = hunks
        .where((hunk) => hunk.newLength == 0)
        .fold(0, (count, hunk) => count + hunk.oldLength);
  }
  return TranscriptEditStats(added: added, removed: removed);
}

int _contentLineCount(String content) {
  if (content.isEmpty) return 0;
  final lines = content.split('\n');
  return lines.length - (lines.last.isEmpty ? 1 : 0);
}

String compactTranscriptNumber(int value) {
  if (value < 1000) return '$value';
  if (value < 1000000) {
    return '${_compactDecimal(value / 1000)}K';
  }
  return '${_compactDecimal(value / 1000000)}M';
}

String _compactDecimal(double value) {
  final fixed = value.toStringAsFixed(1);
  return fixed.endsWith('.0') ? fixed.substring(0, fixed.length - 2) : fixed;
}

List<Map> _messageBlocks(Map<String, dynamic> payload) {
  final message = payload['message'];
  if (message is! Map || message['content'] is! List) return const [];
  return (message['content'] as List).whereType<Map>().toList();
}

List<TranscriptAttachment> _attachments(Object? raw) {
  if (raw is! List) return const [];
  return raw
      .whereType<Map>()
      .map((attachment) {
        final mimetype = _string(attachment['mimetype']);
        return TranscriptAttachment(
          type:
              _string(attachment['type']) ??
              (mimetype?.startsWith('image/') == true ? 'image' : 'file'),
          path: _string(attachment['path']),
          name:
              _string(attachment['name']) ??
              _string(attachment['originalName']) ??
              _string(attachment['filename']),
          size: _number(attachment['size'])?.round(),
        );
      })
      .toList(growable: false);
}

String? _string(Object? value) => value is String ? value : null;
double? _number(Object? value) => value is num ? value.toDouble() : null;
