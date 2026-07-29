import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/attachment_clipboard.dart';

final attachmentClipboardProvider = Provider<AttachmentClipboard>(
  (ref) => const _UnavailableAttachmentClipboard(),
);

class _UnavailableAttachmentClipboard implements AttachmentClipboard {
  const _UnavailableAttachmentClipboard();

  @override
  Future<ClipboardAttachmentResult> read({
    required int availableFiles,
    required int maxBytes,
  }) async => const ClipboardAttachmentResult();

  @override
  Future<ClipboardAttachmentResult> readInsertedContent({
    required String uri,
    required String mimeType,
    required int maxBytes,
  }) async => const ClipboardAttachmentResult();
}
