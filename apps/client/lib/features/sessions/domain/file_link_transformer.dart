class ProjectFileLinkContext {
  const ProjectFileLinkContext({
    required this.peonId,
    required this.projectId,
    required this.projectRoot,
    this.currentOrigin,
  });

  final String peonId;
  final String projectId;
  final String projectRoot;
  final String? currentOrigin;
}

class ProjectFileLink {
  const ProjectFileLink({required this.relativePath, required this.viewerHref});

  final String relativePath;
  final String viewerHref;
}

class FileLinkTransformer {
  const FileLinkTransformer();

  ProjectFileLink? projectFile(String href, ProjectFileLinkContext context) {
    final decoded = _decodedPath(href, context.currentOrigin);
    if (decoded == null) return null;
    final root = context.projectRoot
        .replaceAll('\\', '/')
        .replaceFirst(RegExp(r'/+$'), '');
    final candidate = decoded.path.replaceAll('\\', '/');
    if (root.isEmpty || candidate == root || !candidate.startsWith('$root/')) {
      return null;
    }
    final relative = candidate.substring(root.length + 1);
    final segments = relative.split('/');
    if (segments.isEmpty ||
        segments.any(
          (segment) => segment.isEmpty || segment == '.' || segment == '..',
        )) {
      return null;
    }
    final encoded = segments.map(Uri.encodeComponent).join('/');
    return ProjectFileLink(
      relativePath: relative,
      viewerHref:
          '/view/${Uri.encodeComponent(context.peonId)}/'
          '${Uri.encodeComponent(context.projectId)}/$encoded${decoded.suffix}',
    );
  }

  String? projectRelativePath(String href, ProjectFileLinkContext context) {
    final pathOnly = _splitSuffix(href).path;
    final prefix =
        '/view/${Uri.encodeComponent(context.peonId)}/'
        '${Uri.encodeComponent(context.projectId)}/';
    if (!pathOnly.startsWith(prefix)) return null;
    final encoded = pathOnly.substring(prefix.length);
    if (encoded.isEmpty) return null;
    try {
      final segments = encoded.split('/').map(Uri.decodeComponent).toList();
      if (segments.any(
        (segment) =>
            segment.isEmpty ||
            segment == '.' ||
            segment == '..' ||
            segment.contains('/') ||
            segment.contains('\\'),
      )) {
        return null;
      }
      return segments.join('/');
    } on FormatException {
      return null;
    }
  }

  String? localFilePath(String href) {
    if (href.isEmpty) return null;
    var path = href;
    try {
      path = Uri.decodeFull(path);
    } on FormatException {
      // Keep malformed escapes intact, matching the web fallback.
    }
    if (path.startsWith('file://')) {
      final uri = Uri.tryParse(path);
      if (uri == null) return null;
      path = uri.path;
    }
    final absolutePosix = path.startsWith('/') && !path.startsWith('//');
    final absoluteWindows = RegExp(r'^[a-zA-Z]:[\\/]').hasMatch(path);
    if (!absolutePosix && !absoluteWindows) return null;
    return path
        .replaceFirst(RegExp(r'#L\d+(?:-L?\d+)?$'), '')
        .replaceFirst(RegExp(r':\d+(?::\d+)?$'), '');
  }
}

({String path, String suffix}) _splitSuffix(String value) {
  final index = value.indexOf(RegExp(r'[?#]'));
  return index < 0
      ? (path: value, suffix: '')
      : (path: value.substring(0, index), suffix: value.substring(index));
}

({String path, String suffix})? _decodedPath(
  String href,
  String? currentOrigin,
) {
  if (RegExp(r'^https?://', caseSensitive: false).hasMatch(href)) {
    final uri = Uri.tryParse(href);
    final origin = Uri.tryParse(currentOrigin ?? '');
    if (uri == null ||
        origin == null ||
        uri.scheme != origin.scheme ||
        uri.host != origin.host ||
        uri.port != origin.port) {
      return null;
    }
    return (path: uri.path, suffix: _uriSuffix(uri));
  }
  if (href.startsWith('file://')) {
    final uri = Uri.tryParse(href);
    if (uri == null) return null;
    return (path: uri.path, suffix: _uriSuffix(uri));
  }
  final split = _splitSuffix(href);
  final absoluteWindows = RegExp(r'^[a-zA-Z]:[\\/]').hasMatch(split.path);
  if (!absoluteWindows &&
      (!split.path.startsWith('/') || split.path.startsWith('//'))) {
    return null;
  }
  try {
    return (path: Uri.decodeFull(split.path), suffix: split.suffix);
  } on FormatException {
    return null;
  }
}

String _uriSuffix(Uri uri) {
  final query = uri.hasQuery ? '?${uri.query}' : '';
  final fragment = uri.hasFragment ? '#${uri.fragment}' : '';
  return '$query$fragment';
}
