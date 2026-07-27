part of 'session_detail_page.dart';

mixin _SessionDetailAttachmentMethods on _SessionDetailAttachmentHost {
  Future<void> _pickAttachments() async {
    const maxFiles = 10;
    const maxBytes = 25 * 1024 * 1024;
    setState(() {
      _readingAttachments = true;
      _attachmentError = null;
    });
    try {
      final result = await FilePicker.pickFiles(
        allowMultiple: true,
        withData: false,
      );
      if (!mounted || result == null) return;
      final selected = <NewSessionAttachment>[];
      var rejectedLargeFiles = 0;
      var rejectedExtraFiles = 0;
      final available = maxFiles - _composerAttachments.length;
      for (final file in result.files) {
        if (file.size > maxBytes) {
          rejectedLargeFiles++;
          continue;
        }
        if (selected.length >= available) {
          rejectedExtraFiles++;
          continue;
        }
        final bytes = file.bytes ?? await file.xFile.readAsBytes();
        selected.add(
          NewSessionAttachment(
            name: file.name,
            type: _isImageName(file.name) ? 'image' : 'file',
            bytes: bytes,
          ),
        );
      }
      final errors = <String>[
        if (rejectedLargeFiles > 0)
          '$rejectedLargeFiles '
              '${rejectedLargeFiles == 1 ? 'file is' : 'files are'} larger than 25 MB.',
        if (rejectedExtraFiles > 0)
          'You can attach up to 10 files; '
              '$rejectedExtraFiles ${rejectedExtraFiles == 1 ? 'file was' : 'files were'} not added.',
      ];
      if (selected.isNotEmpty) _resetSubmissionIdentity();
      setState(() {
        _composerAttachments = [..._composerAttachments, ...selected];
        _attachmentError = errors.isEmpty ? null : errors.join(' ');
      });
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
    const maxFiles = 10;
    const maxBytes = 25 * 1024 * 1024;
    setState(() {
      _readingAttachments = true;
      _attachmentError = null;
    });
    try {
      final result = await ref
          .read(attachmentClipboardProvider)
          .read(
            availableFiles: maxFiles - _composerAttachments.length,
            maxBytes: maxBytes,
          );
      if (!mounted) return;
      final errors = _attachmentLimitErrors(
        skippedTooLarge: result.skippedTooLarge,
        skippedForLimit: result.skippedForLimit,
      );
      if (result.attachments.isNotEmpty) {
        _resetSubmissionIdentity();
      }
      setState(() {
        _composerAttachments = [
          ..._composerAttachments,
          for (final attachment in result.attachments)
            NewSessionAttachment(
              name: attachment.name,
              type: attachment.type,
              bytes: attachment.bytes,
            ),
        ];
        _attachmentError = result.attachments.isEmpty && errors.isEmpty
            ? 'The clipboard does not contain an image or file.'
            : errors.isEmpty
            ? null
            : errors.join(' ');
      });
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

  void _insertKeyboardContent(KeyboardInsertedContent content) {
    const maxFiles = 10;
    const maxBytes = 25 * 1024 * 1024;
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
        _insertKeyboardUriContent(
          uri: uri,
          mimeType: content.mimeType,
          maxBytes: maxBytes,
        ),
      );
      return;
    }
    final errors = _attachmentLimitErrors(
      skippedTooLarge: bytes.length > maxBytes ? 1 : 0,
      skippedForLimit: _composerAttachments.length >= maxFiles ? 1 : 0,
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
    _resetSubmissionIdentity();
    setState(() {
      _composerAttachments = [
        ..._composerAttachments,
        NewSessionAttachment(
          name:
              'pasted-image-${DateTime.now().millisecondsSinceEpoch}.$extension',
          type: 'image',
          bytes: bytes,
        ),
      ];
      _attachmentError = null;
    });
  }

  Future<void> _insertKeyboardUriContent({
    required String uri,
    required String mimeType,
    required int maxBytes,
  }) async {
    const maxFiles = 10;
    if (_composerAttachments.length >= maxFiles) {
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
            maxBytes: maxBytes,
          );
      if (!mounted) return;
      final errors = _attachmentLimitErrors(
        skippedTooLarge: result.skippedTooLarge,
        skippedForLimit: result.skippedForLimit,
      );
      if (result.attachments.isNotEmpty) {
        _resetSubmissionIdentity();
      }
      setState(() {
        _composerAttachments = [
          ..._composerAttachments,
          ...result.attachments.map(
            (attachment) => NewSessionAttachment(
              name: attachment.name,
              type: attachment.type,
              bytes: attachment.bytes,
            ),
          ),
        ];
        _attachmentError = result.attachments.isEmpty && errors.isEmpty
            ? 'The pasted image could not be read.'
            : errors.isEmpty
            ? null
            : errors.join(' ');
      });
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

  void _resetSubmissionIdentity() {
    ref
        .read(
          sessionComposerControllerProvider(
            FollowupScope(
              workspaceId: workspaceId,
              peonId: peonId,
              sessionId:
                  session?.sessionId ??
                  _SessionDetailPageState._newSessionDraftId,
            ),
          ).notifier,
        )
        .resetSubmissionIdentity();
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
    return ListTile(
      onTap: onTap,
      shape: RoundedRectangleBorder(borderRadius: AppMotion.optionShape),
      tileColor: AppColors.iron950,
      leading: Icon(icon, size: 20, color: AppColors.felBright),
      title: Text(
        title,
        style: AppTypography.body(fontWeight: FontWeight.w600),
      ),
      subtitle: Text(
        subtitle,
        style: AppTypography.body(fontSize: 12, color: AppColors.boneFaint),
      ),
      trailing: const Icon(
        LucideIcons.chevronRight,
        size: 16,
        color: AppColors.boneFaint,
      ),
    );
  }
}

bool _isImageName(String name) {
  final lower = name.toLowerCase();
  return const ['.png', '.jpg', '.jpeg', '.gif', '.webp'].any(lower.endsWith);
}

ModelProvider? _modelProviderFor(
  ModelsCatalog? catalog, {
  String? agent,
  String? model,
}) {
  if (catalog == null || catalog.providers.isEmpty) return null;
  for (final provider in catalog.providers) {
    if (provider.agent == agent) return provider;
  }
  if (model != null) {
    for (final provider in catalog.providers) {
      if (provider.models.any(
        (option) => option.id == model || option.alias == model,
      )) {
        return provider;
      }
    }
  }
  for (final provider in catalog.providers) {
    if (provider.agent == catalog.defaultAgent) return provider;
  }
  return catalog.providers.first;
}

String _catalogLabel(
  List<ModelCatalogOption>? options,
  String? value, {
  required String fallback,
}) {
  if (value == null) {
    for (final option in options ?? const <ModelCatalogOption>[]) {
      if (option.isDefault) return option.label;
    }
    return fallback;
  }
  for (final option in options ?? const <ModelCatalogOption>[]) {
    if (option.id == value || option.alias == value) return option.label;
  }
  return value;
}

String? _submissionLabel(SessionComposerState? state, {required bool running}) {
  final followup = state?.followupProgress;
  if (followup != null) {
    return switch (followup.stage) {
      FollowupSubmissionStage.uploading =>
        'Uploading ${followup.current} of ${followup.total}: '
            '${followup.fileName}',
      FollowupSubmissionStage.submitting =>
        running ? 'Adding to queue…' : 'Sending message…',
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
