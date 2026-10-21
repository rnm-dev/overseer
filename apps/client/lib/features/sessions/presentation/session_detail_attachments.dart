part of 'session_detail_page.dart';

const _maxAttachmentFiles = 10;
const _maxAttachmentBytes = 25 * 1024 * 1024;

/// Composer attachment state and the pickers that fill it.
mixin _SessionDetailAttachments on ConsumerState<SessionDetailPage> {
  List<NewSessionAttachment> _composerAttachments = const [];
  String? _attachmentError;
  bool _readingAttachments = false;

  void _resetSubmissionIdentity();

  /// Appends [added], invalidating the pending submission identity when
  /// anything was added, and records [error] (or clears it).
  void _appendAttachments(
    Iterable<NewSessionAttachment> added, {
    String? error,
  }) {
    // Pickers await per-file reads after their own mounted check.
    if (!mounted) return;
    final list = added.toList();
    if (list.isNotEmpty) _resetSubmissionIdentity();
    setState(() {
      _composerAttachments = [..._composerAttachments, ...list];
      _attachmentError = error;
    });
  }

  String? _joinErrors(List<String> errors) =>
      errors.isEmpty ? null : errors.join(' ');

  Future<void> _pickImages(ImageSource source) async {
    final available = _maxAttachmentFiles - _composerAttachments.length;
    if (available <= 0) {
      setState(
        () => _attachmentError = _attachmentLimitErrors(
          skippedTooLarge: 0,
          skippedForLimit: 1,
        ).join(' '),
      );
      return;
    }

    setState(() {
      _readingAttachments = true;
      _attachmentError = null;
    });
    try {
      final picker = ImagePicker();
      final images = source == ImageSource.gallery
          ? await picker.pickMultiImage(limit: available)
          : <XFile?>[
              await picker.pickImage(source: ImageSource.camera),
            ].nonNulls.toList();
      if (!mounted || images.isEmpty) return;

      final selected = <NewSessionAttachment>[];
      var rejectedLargeFiles = 0;
      var rejectedExtraFiles = 0;
      for (final image in images) {
        final size = await image.length();
        if (size > _maxAttachmentBytes) {
          rejectedLargeFiles++;
          continue;
        }
        if (selected.length >= available) {
          rejectedExtraFiles++;
          continue;
        }
        selected.add(
          NewSessionAttachment(
            name: image.name,
            type: 'image',
            bytes: await image.readAsBytes(),
          ),
        );
      }
      _appendAttachments(
        selected,
        error: _joinErrors(
          _attachmentLimitErrors(
            skippedTooLarge: rejectedLargeFiles,
            skippedForLimit: rejectedExtraFiles,
          ),
        ),
      );
    } catch (_) {
      if (!mounted) return;
      setState(
        () => _attachmentError = source == ImageSource.camera
            ? 'A photo could not be taken.'
            : 'Images could not be selected.',
      );
    } finally {
      if (mounted) {
        setState(() {
          _readingAttachments = false;
        });
      }
    }
  }

  Future<void> _pickAttachments() async {
    setState(() {
      _readingAttachments = true;
      _attachmentError = null;
    });
    try {
      final result = await FilePicker.pickFiles();
      if (!mounted || result.isEmpty) return;
      final selected = <NewSessionAttachment>[];
      var rejectedLargeFiles = 0;
      var rejectedExtraFiles = 0;
      final available = _maxAttachmentFiles - _composerAttachments.length;
      for (final file in result) {
        final size = file.lengthSync() ?? await file.length();
        if (size > _maxAttachmentBytes) {
          rejectedLargeFiles++;
          continue;
        }
        if (selected.length >= available) {
          rejectedExtraFiles++;
          continue;
        }
        final bytes = await file.readAsBytes();
        selected.add(
          NewSessionAttachment(
            name: file.name,
            type: _isImageName(file.name) ? 'image' : 'file',
            bytes: bytes,
          ),
        );
      }
      _appendAttachments(
        selected,
        error: _joinErrors(
          _attachmentLimitErrors(
            skippedTooLarge: rejectedLargeFiles,
            skippedForLimit: rejectedExtraFiles,
          ),
        ),
      );
    } catch (_) {
      if (!mounted) return;
      setState(() => _attachmentError = 'Files could not be selected.');
    } finally {
      if (mounted) {
        setState(() {
          _readingAttachments = false;
        });
      }
    }
  }

  Future<void> _showAttachmentOptions() {
    return showAppBottomSheet<void>(
      context: context,
      builder: (sheetContext) => AppBottomSheet(
        title: 'Add attachments',
        handleKey: const Key('session-attachment-sheet-handle'),
        children: [
          _AttachmentOption(
            key: const Key('session-attachment-gallery'),
            icon: LucideIcons.images,
            title: 'Photo library',
            subtitle: 'Choose one or more images',
            onTap: () {
              Navigator.of(sheetContext).pop();
              unawaited(_pickImages(ImageSource.gallery));
            },
          ),
          const SizedBox(height: 8),
          _AttachmentOption(
            key: const Key('session-attachment-camera'),
            icon: LucideIcons.camera,
            title: 'Take photo',
            subtitle: 'Use the device camera',
            onTap: () {
              Navigator.of(sheetContext).pop();
              unawaited(_pickImages(ImageSource.camera));
            },
          ),
          const SizedBox(height: 8),
          _AttachmentOption(
            key: const Key('session-attachment-choose-files'),
            icon: LucideIcons.folderOpen,
            title: 'Choose files',
            subtitle: 'Up to 10 files, 25 MB each',
            onTap: () {
              Navigator.of(sheetContext).pop();
              unawaited(_pickAttachments());
            },
          ),
          const SizedBox(height: 8),
          _AttachmentOption(
            key: const Key('session-attachment-paste'),
            icon: LucideIcons.clipboardPaste,
            title: 'Paste from clipboard',
            subtitle: 'Images and copied files',
            onTap: () {
              Navigator.of(sheetContext).pop();
              unawaited(_pasteAttachments());
            },
          ),
        ],
      ),
    );
  }

  Future<void> _pasteAttachments() async {
    setState(() {
      _readingAttachments = true;
      _attachmentError = null;
    });
    try {
      final result = await ref
          .read(attachmentClipboardProvider)
          .read(
            availableFiles: _maxAttachmentFiles - _composerAttachments.length,
            maxBytes: _maxAttachmentBytes,
          );
      if (!mounted) return;
      final errors = _attachmentLimitErrors(
        skippedTooLarge: result.skippedTooLarge,
        skippedForLimit: result.skippedForLimit,
      );
      _appendAttachments(
        result.attachments.map(
          (attachment) => NewSessionAttachment(
            name: attachment.name,
            type: attachment.type,
            bytes: attachment.bytes,
          ),
        ),
        error: result.attachments.isEmpty && errors.isEmpty
            ? 'The clipboard does not contain an image or file.'
            : _joinErrors(errors),
      );
    } catch (_) {
      if (!mounted) return;
      setState(
        () => _attachmentError = 'Clipboard contents could not be pasted.',
      );
    } finally {
      if (mounted) {
        setState(() {
          _readingAttachments = false;
        });
      }
    }
  }

  /// A pasted wall of text is worth more as a file than as a message body.
  /// Returns false when it cannot be taken — the composer then pastes it
  /// inline rather than dropping it.
  bool _attachPastedText(String text) {
    if (_composerAttachments.length >= _maxAttachmentFiles) return false;
    final bytes = Uint8List.fromList(utf8.encode(text));
    if (bytes.length > _maxAttachmentBytes) return false;
    _appendAttachments([
      NewSessionAttachment(
        name: pastedTextName(
          DateTime.now().millisecondsSinceEpoch,
          index: _composerAttachments.length,
        ),
        type: 'file',
        bytes: bytes,
      ),
    ]);
    return true;
  }

  void _insertKeyboardContent(KeyboardInsertedContent content) {
    final bytes = content.data;
    if (bytes == null || bytes.isEmpty) {
      final uri = content.uri;
      if (uri.isEmpty) {
        setState(
          () => _attachmentError = 'The pasted image could not be read.',
        );
        return;
      }
      unawaited(
        _insertKeyboardUriContent(uri: uri, mimeType: content.mimeType),
      );
      return;
    }
    final errors = _attachmentLimitErrors(
      skippedTooLarge: bytes.length > _maxAttachmentBytes ? 1 : 0,
      skippedForLimit: _composerAttachments.length >= _maxAttachmentFiles
          ? 1
          : 0,
    );
    if (errors.isNotEmpty) {
      setState(() => _attachmentError = errors.join(' '));
      return;
    }
    final extension = switch (content.mimeType) {
      'image/jpeg' => 'jpg',
      'image/gif' => 'gif',
      'image/webp' => 'webp',
      _ => 'png',
    };
    _appendAttachments([
      NewSessionAttachment(
        name:
            'pasted-image-${DateTime.now().millisecondsSinceEpoch}.$extension',
        type: 'image',
        bytes: bytes,
      ),
    ]);
  }

  Future<void> _insertKeyboardUriContent({
    required String uri,
    required String mimeType,
  }) async {
    if (_composerAttachments.length >= _maxAttachmentFiles) {
      setState(
        () => _attachmentError = _attachmentLimitErrors(
          skippedTooLarge: 0,
          skippedForLimit: 1,
        ).join(' '),
      );
      return;
    }
    setState(() {
      _readingAttachments = true;
      _attachmentError = null;
    });
    try {
      final result = await ref
          .read(attachmentClipboardProvider)
          .readInsertedContent(
            uri: uri,
            mimeType: mimeType,
            maxBytes: _maxAttachmentBytes,
          );
      if (!mounted) return;
      final errors = _attachmentLimitErrors(
        skippedTooLarge: result.skippedTooLarge,
        skippedForLimit: result.skippedForLimit,
      );
      _appendAttachments(
        result.attachments.map(
          (attachment) => NewSessionAttachment(
            name: attachment.name,
            type: attachment.type,
            bytes: attachment.bytes,
          ),
        ),
        error: result.attachments.isEmpty && errors.isEmpty
            ? 'The pasted image could not be read.'
            : _joinErrors(errors),
      );
    } catch (_) {
      if (mounted) {
        setState(
          () => _attachmentError = 'The pasted image could not be read.',
        );
      }
    } finally {
      if (mounted) {
        setState(() {
          _readingAttachments = false;
        });
      }
    }
  }

  List<String> _attachmentLimitErrors({
    required int skippedTooLarge,
    required int skippedForLimit,
  }) {
    return [
      if (skippedTooLarge > 0) 'Files must be 25 MB or smaller.',
      if (skippedForLimit > 0)
        'You can attach up to 10 files; '
            '$skippedForLimit '
            '${skippedForLimit == 1 ? 'file was' : 'files were'} not added.',
    ];
  }
}

class _AttachmentOption extends StatelessWidget {
  const _AttachmentOption({
    super.key,
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ListTile(
      onTap: onTap,
      shape: RoundedRectangleBorder(borderRadius: AppMotion.optionShape),
      tileColor: AppThemePalette.of(context).surfaceHover,
      leading: Icon(icon, size: 20, color: colors.primary),
      title: Text(
        title,
        style: AppTypography.body(fontWeight: FontWeight.w600),
      ),
      subtitle: Text(
        subtitle,
        style: AppTypography.body(fontSize: 12, color: colors.onSurfaceVariant),
      ),
      trailing: Icon(
        LucideIcons.chevronRight,
        size: 16,
        color: colors.onSurfaceVariant,
      ),
    );
  }
}

bool _isImageName(String name) {
  final lower = name.toLowerCase();
  return const ['.png', '.jpg', '.jpeg', '.gif', '.webp'].any(lower.endsWith);
}

String? submissionLabel(SessionComposerState? state, {required bool running}) {
  final followup = state?.followupProgress;
  if (followup != null) {
    return switch (followup.stage) {
      FollowupSubmissionStage.uploading =>
        'Uploading ${followup.current} of ${followup.total}: '
            '${followup.fileName}',
      FollowupSubmissionStage.submitting => null,
    };
  }
  final initial = state?.submissionProgress;
  if (initial != null) {
    return switch (initial.stage) {
      NewSessionSubmissionStage.uploading =>
        'Uploading ${initial.current} of ${initial.total}: ${initial.fileName}',
      NewSessionSubmissionStage.starting => 'Starting session…',
    };
  }
  return null;
}
