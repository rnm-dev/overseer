import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:overseer_mobile/shared/design/colors.dart';

enum FileKind {
  archive,
  audio,
  code,
  config,
  data,
  database,
  image,
  javascript,
  json,
  shell,
  stylesheet,
  text,
  typescript,
  video,
  web,
  unknown,
}

class _FileTypeAppearance {
  const _FileTypeAppearance({required this.icon, required this.color});

  final IconData icon;
  final Color color;
}

const Map<String, FileKind> _extensionKinds = <String, FileKind>{
  // JavaScript and TypeScript split for clear iconography.
  'js': FileKind.javascript,
  'jsx': FileKind.javascript,
  'mjs': FileKind.javascript,
  'cjs': FileKind.javascript,
  'ts': FileKind.typescript,
  'tsx': FileKind.typescript,
  'mts': FileKind.typescript,
  'cts': FileKind.typescript,
  'html': FileKind.web,
  'htm': FileKind.web,
  'vue': FileKind.web,
  'svelte': FileKind.web,
  'astro': FileKind.web,
  'css': FileKind.stylesheet,
  'scss': FileKind.stylesheet,
  'sass': FileKind.stylesheet,
  'less': FileKind.stylesheet,
  'styl': FileKind.stylesheet,
  'py': FileKind.code,
  'rb': FileKind.code,
  'php': FileKind.code,
  'java': FileKind.code,
  'kt': FileKind.code,
  'kts': FileKind.code,
  'go': FileKind.code,
  'rs': FileKind.code,
  'c': FileKind.code,
  'h': FileKind.code,
  'cpp': FileKind.code,
  'cc': FileKind.code,
  'cxx': FileKind.code,
  'cs': FileKind.code,
  'swift': FileKind.code,
  'scala': FileKind.code,
  'ex': FileKind.code,
  'exs': FileKind.code,
  'lua': FileKind.code,
  'json': FileKind.json,
  'jsonc': FileKind.json,
  'json5': FileKind.json,
  'geojson': FileKind.json,
  'yaml': FileKind.config,
  'yml': FileKind.config,
  'toml': FileKind.config,
  'ini': FileKind.config,
  'conf': FileKind.config,
  'env': FileKind.config,
  'properties': FileKind.config,
  'xml': FileKind.config,
  'lock': FileKind.config,
  'md': FileKind.text,
  'mdx': FileKind.text,
  'txt': FileKind.text,
  'rst': FileKind.text,
  'log': FileKind.text,
  'tex': FileKind.text,
  'adoc': FileKind.text,
  'csv': FileKind.data,
  'tsv': FileKind.data,
  'xls': FileKind.data,
  'xlsx': FileKind.data,
  'ods': FileKind.data,
  'parquet': FileKind.data,
  'sql': FileKind.database,
  'db': FileKind.database,
  'sqlite': FileKind.database,
  'sqlite3': FileKind.database,
  'png': FileKind.image,
  'jpg': FileKind.image,
  'jpeg': FileKind.image,
  'gif': FileKind.image,
  'webp': FileKind.image,
  'svg': FileKind.image,
  'bmp': FileKind.image,
  'ico': FileKind.image,
  'avif': FileKind.image,
  'tif': FileKind.image,
  'tiff': FileKind.image,
  'psd': FileKind.image,
  'mp3': FileKind.audio,
  'wav': FileKind.audio,
  'ogg': FileKind.audio,
  'flac': FileKind.audio,
  'm4a': FileKind.audio,
  'aac': FileKind.audio,
  'mp4': FileKind.video,
  'webm': FileKind.video,
  'mov': FileKind.video,
  'avi': FileKind.video,
  'mkv': FileKind.video,
  'm4v': FileKind.video,
  'zip': FileKind.archive,
  'gz': FileKind.archive,
  'tgz': FileKind.archive,
  'bz2': FileKind.archive,
  'xz': FileKind.archive,
  'rar': FileKind.archive,
  '7z': FileKind.archive,
  'tar': FileKind.archive,
  'jar': FileKind.archive,
  'war': FileKind.archive,
  'pdf': FileKind.archive,
};

const Map<FileKind, _FileTypeAppearance> _kindAppearance =
    <FileKind, _FileTypeAppearance>{
      FileKind.archive: _FileTypeAppearance(
        icon: LucideIcons.fileArchive,
        color: AppColors.ember,
      ),
      FileKind.audio: _FileTypeAppearance(
        icon: LucideIcons.audioLines,
        color: AppColors.forge,
      ),
      FileKind.code: _FileTypeAppearance(
        icon: LucideIcons.fileCode,
        color: AppColors.felBright,
      ),
      FileKind.config: _FileTypeAppearance(
        icon: LucideIcons.settings,
        color: AppColors.forgeDeep,
      ),
      FileKind.data: _FileTypeAppearance(
        icon: LucideIcons.table,
        color: AppColors.felDim,
      ),
      FileKind.database: _FileTypeAppearance(
        icon: LucideIcons.database,
        color: AppColors.iron500,
      ),
      FileKind.image: _FileTypeAppearance(
        icon: LucideIcons.image,
        color: AppColors.ember,
      ),
      FileKind.javascript: _FileTypeAppearance(
        icon: LucideIcons.fileCode,
        color: AppColors.forge,
      ),
      FileKind.json: _FileTypeAppearance(
        icon: LucideIcons.fileJson,
        color: AppColors.iron600,
      ),
      FileKind.shell: _FileTypeAppearance(
        icon: LucideIcons.terminal,
        color: AppColors.bone,
      ),
      FileKind.stylesheet: _FileTypeAppearance(
        icon: LucideIcons.palette,
        color: AppColors.forgeDeep,
      ),
      FileKind.text: _FileTypeAppearance(
        icon: LucideIcons.fileText,
        color: AppColors.boneDim,
      ),
      FileKind.typescript: _FileTypeAppearance(
        icon: LucideIcons.fileCode,
        color: AppColors.bone,
      ),
      FileKind.video: _FileTypeAppearance(
        icon: LucideIcons.video,
        color: AppColors.blood,
      ),
      FileKind.web: _FileTypeAppearance(
        icon: LucideIcons.globe,
        color: AppColors.fel,
      ),
      FileKind.unknown: _FileTypeAppearance(
        icon: LucideIcons.file,
        color: AppColors.boneFaint,
      ),
    };

FileKind fileKindForName(String name) {
  final String normalized = name.trim().replaceAll('\\', '/');
  final String base = normalized.split('/').last.toLowerCase();
  if (base == 'dockerfile' || base == 'makefile' || base == 'justfile') {
    return FileKind.shell;
  }

  final int dotIndex = base.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex == base.length - 1) {
    return FileKind.unknown;
  }

  final String extension = base.substring(dotIndex + 1);
  return _extensionKinds[extension] ?? FileKind.unknown;
}

class FileTypeIcon extends StatelessWidget {
  const FileTypeIcon({
    super.key,
    required this.name,
    this.size = 15,
    this.color,
    this.semanticsLabel,
  });

  final String name;
  final double size;
  final Color? color;
  final String? semanticsLabel;

  @override
  Widget build(BuildContext context) {
    final FileKind kind = fileKindForName(name);
    final _FileTypeAppearance appearance = _kindAppearance[kind]!;
    return Icon(
      appearance.icon,
      size: size,
      color: color ?? appearance.color,
      semanticLabel: semanticsLabel,
    );
  }
}
