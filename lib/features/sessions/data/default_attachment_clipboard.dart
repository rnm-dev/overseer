import '../../../core/platform/attachment_clipboard_reader.dart';
import '../domain/attachment_clipboard.dart';

class DefaultAttachmentClipboard implements AttachmentClipboard {
  const DefaultAttachmentClipboard();

  @override
  Future<ClipboardAttachmentResult> read({
    required int availableFiles,
    required int maxBytes,
  }) async {
    final result = await readPlatformClipboardAttachments(
      availableFiles: availableFiles,
      maxBytes: maxBytes,
    );
    return ClipboardAttachmentResult(
      attachments: [
        for (final attachment in result.attachments)
          ClipboardAttachment(
            name: attachment.name,
            type: attachment.type,
            bytes: attachment.bytes,
          ),
      ],
      skippedTooLarge: result.skippedTooLarge,
      skippedForLimit: result.skippedForLimit,
    );
  }

  @override
  Future<ClipboardAttachmentResult> readInsertedContent({
    required String uri,
    required String mimeType,
    required int maxBytes,
  }) async {
    final result = await readPlatformInsertedAttachment(
      uri: uri,
      mimeType: mimeType,
      maxBytes: maxBytes,
    );
    return ClipboardAttachmentResult(
      attachments: [
        for (final attachment in result.attachments)
          ClipboardAttachment(
            name: attachment.name,
            type: attachment.type,
            bytes: attachment.bytes,
          ),
      ],
      skippedTooLarge: result.skippedTooLarge,
      skippedForLimit: result.skippedForLimit,
    );
  }
}
