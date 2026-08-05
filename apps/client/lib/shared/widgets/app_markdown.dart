import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:markdown/markdown.dart' as md;

import '../design/typography.dart';

/// Selectable GitHub-Flavored Markdown for conversational content.
class AppMarkdown extends StatelessWidget {
  const AppMarkdown({
    super.key,
    required this.data,
    required this.textStyle,
    this.selectable = true,
    this.onTapLink,
  });

  final String data;
  final TextStyle textStyle;
  final bool selectable;
  final ValueChanged<String>? onTapLink;

  @override
  Widget build(BuildContext context) {
    return MarkdownBody(
      data: data,
      selectable: selectable,
      styleSheet: _messageStyleSheet(context, textStyle),
      onTapLink: onTapLink == null
          ? null
          : (_, href, _) {
              if (href != null && href.trim().isNotEmpty) {
                onTapLink!(href);
              }
            },
    );
  }
}

/// A one-line Markdown summary for dense rows.
///
/// Block elements are flattened while inline emphasis remains visible, so a
/// heading or list cannot increase a session row's fixed height.
class AppMarkdownPreview extends StatelessWidget {
  const AppMarkdownPreview({
    super.key,
    required this.data,
    required this.style,
    this.maxLines = 1,
    this.overflow = TextOverflow.fade,
    this.softWrap = false,
  });

  final String data;
  final TextStyle style;
  final int maxLines;
  final TextOverflow overflow;
  final bool softWrap;

  @override
  Widget build(BuildContext context) {
    return RichText(
      text: _inlineMarkdownSpan(context, data, style),
      maxLines: maxLines,
      overflow: overflow,
      softWrap: softWrap,
      textScaler: MediaQuery.textScalerOf(context),
    );
  }
}

MarkdownStyleSheet _messageStyleSheet(
  BuildContext context,
  TextStyle textStyle,
) {
  final colors = Theme.of(context).colorScheme;
  final fontSize = textStyle.fontSize ?? 14;
  final headingColor = textStyle.color ?? colors.onSurface;
  return MarkdownStyleSheet(
    a: textStyle.copyWith(
      color: colors.primary,
      decoration: TextDecoration.underline,
    ),
    p: textStyle,
    code: AppTypography.mono(
      fontSize: fontSize * 0.86,
      color: colors.tertiary,
    ).copyWith(backgroundColor: Colors.transparent, shadows: const []),
    h1: AppTypography.display(
      fontSize: fontSize * 1.43,
      fontWeight: FontWeight.w700,
      color: headingColor,
      height: 1.25,
    ),
    h2: AppTypography.display(
      fontSize: fontSize * 1.21,
      fontWeight: FontWeight.w700,
      color: headingColor,
      height: 1.25,
    ),
    h3: AppTypography.display(
      fontSize: fontSize * 1.07,
      fontWeight: FontWeight.w700,
      color: headingColor,
      height: 1.25,
    ),
    h4: AppTypography.display(
      fontSize: fontSize,
      fontWeight: FontWeight.w700,
      color: headingColor,
      height: 1.25,
    ),
    h5: AppTypography.display(
      fontSize: fontSize * 0.93,
      fontWeight: FontWeight.w700,
      color: headingColor,
      height: 1.25,
    ),
    h6: AppTypography.display(
      fontSize: fontSize * 0.93,
      fontWeight: FontWeight.w700,
      color: colors.onSurfaceVariant,
      height: 1.25,
    ),
    em: const TextStyle(fontStyle: FontStyle.italic),
    strong: TextStyle(color: headingColor, fontWeight: FontWeight.w700),
    del: const TextStyle(decoration: TextDecoration.lineThrough),
    blockSpacing: 10,
    listIndent: 22,
    listBullet: textStyle.copyWith(color: colors.onSurfaceVariant),
    blockquote: textStyle.copyWith(color: colors.onSurfaceVariant, height: 1.5),
    blockquotePadding: const EdgeInsets.fromLTRB(12, 4, 8, 4),
    blockquoteDecoration: BoxDecoration(
      border: Border(left: BorderSide(color: colors.primary, width: 3)),
    ),
    codeblockPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
    codeblockDecoration: BoxDecoration(
      color: colors.surfaceContainerHighest,
      border: Border.all(color: colors.outlineVariant),
      borderRadius: BorderRadius.circular(7),
    ),
    tableHead: AppTypography.display(
      fontSize: fontSize * 0.86,
      fontWeight: FontWeight.w600,
      color: headingColor,
    ),
    tableBody: textStyle.copyWith(
      fontSize: fontSize * 0.86,
      color: colors.onSurfaceVariant,
    ),
    tableBorder: TableBorder.all(color: colors.outlineVariant),
    tableCellsPadding: const EdgeInsets.symmetric(horizontal: 9, vertical: 7),
    horizontalRuleDecoration: BoxDecoration(
      border: Border(top: BorderSide(color: colors.outline)),
    ),
  );
}

TextSpan _inlineMarkdownSpan(
  BuildContext context,
  String source,
  TextStyle baseStyle,
) {
  final colors = Theme.of(context).colorScheme;
  final document = md.Document(
    extensionSet: md.ExtensionSet.gitHubFlavored,
    encodeHtml: false,
  );
  final nodes = document.parseLines(const LineSplitter().convert(source));
  final children = <InlineSpan>[];
  for (final node in nodes) {
    if (children.isNotEmpty) children.add(const TextSpan(text: ' '));
    children.add(_inlineNode(node, colors));
  }
  return TextSpan(style: baseStyle, children: children);
}

InlineSpan _inlineNode(md.Node node, ColorScheme colors) {
  if (node is md.Text) {
    return TextSpan(text: node.text.replaceAll(RegExp(r'\s+'), ' '));
  }
  if (node is! md.Element) return const TextSpan();
  if (node.tag == 'br') return const TextSpan(text: ' ');
  if (node.tag == 'input' && node.attributes['type'] == 'checkbox') {
    return TextSpan(text: node.attributes.containsKey('checked') ? '☑ ' : '☐ ');
  }
  if (node.tag == 'ul' || node.tag == 'ol') {
    final ordered = node.tag == 'ol';
    final items = node.children ?? const <md.Node>[];
    return TextSpan(
      children: [
        for (final (index, item) in items.indexed) ...[
          if (index > 0) const TextSpan(text: '  '),
          TextSpan(text: ordered ? '${index + 1}. ' : '• '),
          _inlineNode(item, colors),
        ],
      ],
    );
  }

  final style = switch (node.tag) {
    'strong' => const TextStyle(fontWeight: FontWeight.w700),
    'em' => const TextStyle(fontStyle: FontStyle.italic),
    'del' => const TextStyle(decoration: TextDecoration.lineThrough),
    'code' || 'pre' => AppTypography.mono(color: colors.tertiary),
    'a' => TextStyle(
      color: colors.primary,
      decoration: TextDecoration.underline,
    ),
    'h1' ||
    'h2' ||
    'h3' ||
    'h4' ||
    'h5' ||
    'h6' => const TextStyle(fontWeight: FontWeight.w700),
    _ => null,
  };
  return TextSpan(
    style: style,
    children: [
      for (final child in node.children ?? const <md.Node>[])
        _inlineNode(child, colors),
    ],
  );
}
