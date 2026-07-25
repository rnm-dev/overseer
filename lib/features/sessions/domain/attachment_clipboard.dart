import 'dart:typed_data';

class ClipboardAttachment {
  const ClipboardAttachment({
    required this.name,
    required this.type,
    required this.bytes,
  });

  final String name;
  final String type;
  final Uint8List bytes;
}

class ClipboardAttachmentResult {
  const ClipboardAttachmentResult({
    this.attachments = const [],
    this.skippedTooLarge = 0,
    this.skippedForLimit = 0,
  });

  final List<ClipboardAttachment> attachments;
  final int skippedTooLarge;
  final int skippedForLimit;
}

abstract interface class AttachmentClipboard {
  Future<ClipboardAttachmentResult> read({
    required int availableFiles,
    required int maxBytes,
  });

  Future<ClipboardAttachmentResult> readInsertedContent({
    required String uri,
    required String mimeType,
    required int maxBytes,
  });
}
