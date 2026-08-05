import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_highlight/flutter_highlight.dart';
import 'package:flutter_highlight/themes/atom-one-dark.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_mermaid/flutter_mermaid.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:pdfrx/pdfrx.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../../features/themes/domain/app_theme_package.dart';
import '../design/colors.dart';
import '../design/typography.dart';
import 'app_button.dart';

enum FileViewMode { preview, source }

class FileViewBlock extends StatelessWidget {
  const FileViewBlock({
    super.key,
    required this.path,
    required this.bytes,
    this.contentType,
    required this.mode,
    this.onOpenDesktopHtmlPreview,
  });

  final String path;
  final Uint8List bytes;
  final String? contentType;
  final FileViewMode mode;
  final Future<void> Function(String document)? onOpenDesktopHtmlPreview;

  @override
  Widget build(BuildContext context) {
    if (_isPdf(path, contentType)) {
      return ColoredBox(
        key: const Key('file-view-pdf-preview'),
        color: AppColors.iron900,
        child: PdfViewer.data(
          bytes,
          sourceName: path,
          params: const PdfViewerParams(backgroundColor: AppColors.iron900),
        ),
      );
    }
    if (_isImage(path, contentType)) {
      return InteractiveViewer(
        key: const Key('file-view-image-preview'),
        minScale: 0.5,
        maxScale: 5,
        child: Center(
          child: Image.memory(
            bytes,
            fit: BoxFit.contain,
            errorBuilder: (_, _, _) => const _ViewerMessage(
              icon: LucideIcons.fileWarning,
              title: 'Couldn’t decode image',
              message: 'This image format is not supported.',
            ),
          ),
        ),
      );
    }

    final source = utf8.decode(bytes, allowMalformed: true);
    if (isMarkdownFile(path) && mode == FileViewMode.preview) {
      return _MarkdownPreview(source: source);
    }
    if (isHtmlFile(path) && mode == FileViewMode.preview) {
      return _HtmlPreview(
        source: source,
        onOpenDesktopPreview: onOpenDesktopHtmlPreview,
      );
    }
    return _CodePreview(source: source, path: path);
  }
}

class FileViewModeSwitch extends StatelessWidget {
  const FileViewModeSwitch({
    super.key,
    required this.mode,
    required this.previewLabel,
    required this.onChanged,
  });

  final FileViewMode mode;
  final String previewLabel;
  final ValueChanged<FileViewMode> onChanged;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      key: const Key('file-view-mode'),
      padding: const EdgeInsets.all(2),
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border.all(color: colors.outlineVariant),
        borderRadius: BorderRadius.circular(7),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _ModeButton(
            label: previewLabel,
            selected: mode == FileViewMode.preview,
            onPressed: () => onChanged(FileViewMode.preview),
          ),
          _ModeButton(
            label: 'Code',
            selected: mode == FileViewMode.source,
            onPressed: () => onChanged(FileViewMode.source),
          ),
        ],
      ),
    );
  }
}

class _ModeButton extends StatelessWidget {
  const _ModeButton({
    required this.label,
    required this.selected,
    required this.onPressed,
  });

  final String label;
  final bool selected;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final palette = Theme.of(context).extension<AppThemePalette>()?.package;
    return Semantics(
      button: true,
      selected: selected,
      child: Material(
        color: selected ? colors.primaryContainer : Colors.transparent,
        borderRadius: BorderRadius.circular(5),
        child: InkWell(
          onTap: onPressed,
          borderRadius: BorderRadius.circular(5),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minWidth: 48, minHeight: 32),
            child: Center(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: Text(
                  label,
                  style: AppTypography.mono(
                    fontSize: 10,
                    color: selected
                        ? colors.onPrimaryContainer
                        : palette?.inkFaint ?? colors.onSurfaceVariant,
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

class _MarkdownPreview extends StatelessWidget {
  const _MarkdownPreview({required this.source});

  final String source;

  @override
  Widget build(BuildContext context) {
    return SelectionArea(
      child: SingleChildScrollView(
        key: const Key('file-view-markdown-preview'),
        padding: const EdgeInsets.fromLTRB(18, 18, 18, 36),
        child: MarkdownBody(
          data: source,
          selectable: true,
          builders: {'pre': _MarkdownCodeBlockBuilder()},
          styleSheet: _markdownStyleSheet(context),
        ),
      ),
    );
  }
}

class _MarkdownCodeBlockBuilder extends MarkdownElementBuilder {
  @override
  Widget visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    final code = element.children?.whereType<md.Element>().firstOrNull;
    final source = code?.textContent ?? element.textContent;
    final className = code?.attributes['class'] ?? '';
    final language = RegExp(
      r'(?:^|\s)language-([^\s]+)',
    ).firstMatch(className)?.group(1)?.toLowerCase();
    if (language == 'mermaid') {
      return Container(
        key: const Key('file-view-mermaid-diagram'),
        margin: const EdgeInsets.symmetric(vertical: 8),
        decoration: BoxDecoration(
          color: AppColors.iron950,
          border: Border.all(color: AppColors.iron700),
          borderRadius: BorderRadius.circular(8),
        ),
        child: SizedBox(
          height: 320,
          child: InteractiveViewer(
            minScale: 0.5,
            maxScale: 4,
            boundaryMargin: const EdgeInsets.all(80),
            child: FittedBox(
              fit: BoxFit.contain,
              child: SizedBox(
                width: 520,
                height: 320,
                child: MermaidDiagram(
                  code: source,
                  width: 520,
                  height: 320,
                  style: MermaidStyle.dark(),
                ),
              ),
            ),
          ),
        ),
      );
    }
    return _CodeBlock(source: source, language: _normalizeLanguage(language));
  }
}

class _CodePreview extends StatelessWidget {
  const _CodePreview({required this.source, required this.path});

  final String source;
  final String path;

  @override
  Widget build(BuildContext context) {
    const textCap = 400000;
    final truncated = source.length > textCap;
    final visible = truncated ? source.substring(0, textCap) : source;
    return Column(
      key: const Key('file-view-code-preview'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (truncated)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
            color: AppColors.forgeDeep.withValues(alpha: 0.25),
            child: Text(
              'Showing the first 400,000 characters.',
              style: AppTypography.mono(fontSize: 10, color: AppColors.ember),
            ),
          ),
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.only(bottom: 28),
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: SelectionArea(
                child: HighlightView(
                  visible,
                  language: _languageForPath(path) ?? 'plaintext',
                  theme: atomOneDarkTheme,
                  padding: const EdgeInsets.all(16),
                  textStyle: AppTypography.mono(
                    fontSize: 11,
                    color: AppColors.boneDim,
                    height: 1.5,
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _CodeBlock extends StatelessWidget {
  const _CodeBlock({required this.source, this.language});

  final String source;
  final String? language;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: HighlightView(
        source,
        language: language ?? 'plaintext',
        theme: atomOneDarkTheme,
        padding: const EdgeInsets.all(12),
        textStyle: AppTypography.mono(
          fontSize: 11,
          color: AppColors.boneDim,
          height: 1.45,
        ),
      ),
    );
  }
}

class _HtmlPreview extends StatefulWidget {
  const _HtmlPreview({required this.source, this.onOpenDesktopPreview});

  final String source;
  final Future<void> Function(String document)? onOpenDesktopPreview;

  @override
  State<_HtmlPreview> createState() => _HtmlPreviewState();
}

class _HtmlPreviewState extends State<_HtmlPreview> {
  WebViewController? _controller;
  bool _openingDesktopPreview = false;

  @override
  void initState() {
    super.initState();
    if (!_supportsEmbeddedBrowser) return;
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(Colors.white)
      ..setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (request) {
            final uri = Uri.tryParse(request.url);
            return uri == null || uri.scheme == 'about' || uri.scheme == 'data'
                ? NavigationDecision.navigate
                : NavigationDecision.prevent;
          },
        ),
      )
      ..loadHtmlString(_isolatedHtml(widget.source));
  }

  @override
  void didUpdateWidget(covariant _HtmlPreview oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.source != widget.source) {
      _controller?.loadHtmlString(_isolatedHtml(widget.source));
    }
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    if (controller == null) {
      final openDesktopPreview = widget.onOpenDesktopPreview;
      if (openDesktopPreview != null) {
        return _ViewerMessage(
          key: const Key('file-view-html-external-preview'),
          icon: LucideIcons.appWindow,
          title: 'Preview opens in a separate window',
          message:
              'The isolated browser preview uses the native desktop WebView.',
          action: AppButton(
            key: const Key('file-view-html-open-preview'),
            onPressed: _openingDesktopPreview
                ? null
                : () => _openDesktopPreview(openDesktopPreview),
            loading: _openingDesktopPreview,
            leading: const Icon(LucideIcons.externalLink, size: 15),
            child: const Text('Open Preview'),
          ),
        );
      }
      return const _ViewerMessage(
        key: Key('file-view-html-preview-unavailable'),
        icon: LucideIcons.monitorX,
        title: 'Browser preview unavailable',
        message:
            'HTML browser preview is supported on Android, iOS, and macOS. '
            'Use Code mode on this platform.',
      );
    }
    return ColoredBox(
      key: const Key('file-view-html-preview'),
      color: Colors.white,
      child: WebViewWidget(controller: controller),
    );
  }

  Future<void> _openDesktopPreview(
    Future<void> Function(String document) open,
  ) async {
    setState(() => _openingDesktopPreview = true);
    try {
      await open(_isolatedHtml(widget.source));
    } on Object catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Couldn’t open browser preview: $error')),
      );
    } finally {
      if (mounted) setState(() => _openingDesktopPreview = false);
    }
  }
}

class _ViewerMessage extends StatelessWidget {
  const _ViewerMessage({
    super.key,
    required this.icon,
    required this.title,
    required this.message,
    this.action,
  });

  final IconData icon;
  final String title;
  final String message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final palette = Theme.of(context).extension<AppThemePalette>()?.package;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              icon,
              size: 30,
              color: palette?.inkFaint ?? colors.onSurfaceVariant,
            ),
            const SizedBox(height: 12),
            Text(
              title,
              textAlign: TextAlign.center,
              style: AppTypography.display(
                fontSize: 15,
                fontWeight: FontWeight.w600,
                color: colors.onSurface,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              message,
              textAlign: TextAlign.center,
              style: AppTypography.body(
                fontSize: 13,
                color: palette?.inkFaint ?? colors.onSurfaceVariant,
              ),
            ),
            if (action != null) ...[const SizedBox(height: 16), action!],
          ],
        ),
      ),
    );
  }
}

MarkdownStyleSheet _markdownStyleSheet(BuildContext context) {
  final colors = Theme.of(context).colorScheme;
  return MarkdownStyleSheet(
    a: AppTypography.body(fontSize: 13, color: colors.primary),
    p: AppTypography.body(fontSize: 13, color: colors.onSurface, height: 1.55),
    code: AppTypography.mono(
      fontSize: 11,
      color: colors.secondary,
    ).copyWith(backgroundColor: colors.surfaceContainerHighest),
    h1: AppTypography.display(
      fontSize: 24,
      fontWeight: FontWeight.w700,
      color: colors.onSurface,
    ),
    h2: AppTypography.display(
      fontSize: 20,
      fontWeight: FontWeight.w700,
      color: colors.onSurface,
    ),
    h3: AppTypography.display(
      fontSize: 17,
      fontWeight: FontWeight.w700,
      color: colors.onSurface,
    ),
    h4: AppTypography.display(
      fontSize: 15,
      fontWeight: FontWeight.w700,
      color: colors.onSurface,
    ),
    h5: AppTypography.display(
      fontSize: 14,
      fontWeight: FontWeight.w700,
      color: colors.onSurface,
    ),
    h6: AppTypography.display(
      fontSize: 13,
      fontWeight: FontWeight.w700,
      color: colors.onSurfaceVariant,
    ),
    em: const TextStyle(fontStyle: FontStyle.italic),
    strong: const TextStyle(fontWeight: FontWeight.w700),
    del: const TextStyle(decoration: TextDecoration.lineThrough),
    blockSpacing: 12,
    listIndent: 24,
    listBullet: AppTypography.body(
      fontSize: 13,
      color: colors.onSurfaceVariant,
    ),
    blockquote: AppTypography.body(
      fontSize: 13,
      color: colors.onSurfaceVariant,
      height: 1.5,
    ),
    blockquotePadding: const EdgeInsets.fromLTRB(14, 8, 10, 8),
    blockquoteDecoration: BoxDecoration(
      color: colors.surface,
      border: Border(left: BorderSide(color: colors.primary, width: 3)),
    ),
    tableHead: AppTypography.body(
      fontSize: 12,
      fontWeight: FontWeight.w700,
      color: colors.onSurface,
    ),
    tableBody: AppTypography.body(fontSize: 12, color: colors.onSurfaceVariant),
    tableBorder: TableBorder.all(color: colors.outlineVariant),
    tableCellsPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
    horizontalRuleDecoration: BoxDecoration(
      border: Border(top: BorderSide(color: colors.outlineVariant)),
    ),
  );
}

bool get _supportsEmbeddedBrowser =>
    !kIsWeb &&
    (defaultTargetPlatform == TargetPlatform.android ||
        defaultTargetPlatform == TargetPlatform.iOS ||
        defaultTargetPlatform == TargetPlatform.macOS);

bool isMarkdownFile(String path) =>
    RegExp(r'\.(md|markdown|mdx)$', caseSensitive: false).hasMatch(path);

bool isHtmlFile(String path) =>
    RegExp(r'\.html?$', caseSensitive: false).hasMatch(path);

bool _isPdf(String path, String? contentType) =>
    contentType?.toLowerCase().startsWith('application/pdf') == true ||
    RegExp(r'\.pdf$', caseSensitive: false).hasMatch(path);

bool _isImage(String path, String? contentType) =>
    contentType?.startsWith('image/') == true ||
    RegExp(
      r'\.(png|jpe?g|gif|webp|bmp|ico)$',
      caseSensitive: false,
    ).hasMatch(path);

bool fileSupportsRichPreview(String path) =>
    isMarkdownFile(path) ||
    isHtmlFile(path) ||
    RegExp(
      r'\.(pdf|png|jpe?g|gif|webp|bmp|ico)$',
      caseSensitive: false,
    ).hasMatch(path);

IconData fileViewerIconForPath(String path) {
  if (_isPdf(path, null)) return LucideIcons.fileText;
  if (isMarkdownFile(path)) return LucideIcons.bookOpen;
  if (isHtmlFile(path)) return LucideIcons.globe;
  return LucideIcons.fileCode;
}

String? _languageForPath(String path) {
  final dot = path.lastIndexOf('.');
  if (dot < 0 || dot == path.length - 1) return null;
  return _normalizeLanguage(path.substring(dot + 1).toLowerCase());
}

String? _normalizeLanguage(String? language) => switch (language) {
  'bash' || 'sh' || 'zsh' => 'bash',
  'c' ||
  'cpp' ||
  'csharp' ||
  'css' ||
  'dart' ||
  'dockerfile' ||
  'go' ||
  'graphql' ||
  'ini' ||
  'java' ||
  'json' ||
  'kotlin' ||
  'less' ||
  'lua' ||
  'makefile' ||
  'markdown' ||
  'php' ||
  'powershell' ||
  'python' ||
  'r' ||
  'ruby' ||
  'rust' ||
  'scala' ||
  'scss' ||
  'sql' ||
  'swift' ||
  'typescript' ||
  'xml' ||
  'yaml' => language,
  'cs' => 'csharp',
  'docker' => 'dockerfile',
  'htm' || 'html' => 'xml',
  'js' || 'jsx' || 'mjs' || 'cjs' => 'javascript',
  'kt' || 'kts' => 'kotlin',
  'md' || 'mdx' => 'markdown',
  'py' => 'python',
  'ps1' => 'powershell',
  'rb' => 'ruby',
  'rs' => 'rust',
  'ts' || 'tsx' => 'typescript',
  'yml' => 'yaml',
  _ => null,
};

String _isolatedHtml(String source) =>
    '''
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src data: blob:; media-src data: blob:;
    font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';
    form-action 'none'; base-uri 'none'">
</head>
<body>$source</body>
</html>
''';
