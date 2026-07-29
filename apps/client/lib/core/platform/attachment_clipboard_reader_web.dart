import 'dart:typed_data';

import 'package:pasteboard/pasteboard.dart';

class PlatformClipboardAttachment {
  const PlatformClipboardAttachment({
    required this.name,
    required this.type,
    required this.bytes,
  });

  final String name;
  final String type;
  final Uint8List bytes;
}

class PlatformClipboardAttachmentResult {
  const PlatformClipboardAttachmentResult({
    this.attachments = const [],
    this.skippedTooLarge = 0,
    this.skippedForLimit = 0,
  });

  final List<PlatformClipboardAttachment> attachments;
  final int skippedTooLarge;
  final int skippedForLimit;
}

Future<PlatformClipboardAttachmentResult> readPlatformClipboardAttachments({
  required int availableFiles,
  required int maxBytes,
}) async {
  final image = await Pasteboard.image;
  if (image == null || image.isEmpty) {
    return const PlatformClipboardAttachmentResult();
  }
  if (image.length > maxBytes) {
    return const PlatformClipboardAttachmentResult(skippedTooLarge: 1);
  }
  if (availableFiles == 0) {
    return const PlatformClipboardAttachmentResult(skippedForLimit: 1);
  }
  return PlatformClipboardAttachmentResult(
    attachments: [
      PlatformClipboardAttachment(
        name: 'pasted-image-${DateTime.now().millisecondsSinceEpoch}.png',
        type: 'image',
        bytes: image,
      ),
    ],
  );
}

Future<PlatformClipboardAttachmentResult> readPlatformInsertedAttachment({
  required String uri,
  required String mimeType,
  required int maxBytes,
}) async {
  return const PlatformClipboardAttachmentResult();
}
