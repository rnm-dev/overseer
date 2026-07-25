import 'dart:io';

import 'package:flutter/services.dart';
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
  if (Platform.isAndroid) {
    const channel = MethodChannel('dev.rnm.overseer/attachment-clipboard');
    final payload = await channel.invokeMapMethod<String, dynamic>('read', {
      'maxFiles': availableFiles,
      'maxBytes': maxBytes,
    });
    return _resultFromPayload(payload);
  }
  final paths = await Pasteboard.files();
  if (paths.isNotEmpty) {
    final attachments = <PlatformClipboardAttachment>[];
    var skippedTooLarge = 0;
    var skippedForLimit = 0;
    for (final path in paths) {
      final file = File(path);
      final size = await file.length();
      if (size > maxBytes) {
        skippedTooLarge++;
        continue;
      }
      if (attachments.length >= availableFiles) {
        skippedForLimit++;
        continue;
      }
      final name = path.split(RegExp(r'[/\\]')).last;
      attachments.add(
        PlatformClipboardAttachment(
          name: name.isEmpty ? 'pasted-file' : name,
          type: _isImageName(name) ? 'image' : 'file',
          bytes: await file.readAsBytes(),
        ),
      );
    }
    return PlatformClipboardAttachmentResult(
      attachments: attachments,
      skippedTooLarge: skippedTooLarge,
      skippedForLimit: skippedForLimit,
    );
  }

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
  if (!Platform.isAndroid || uri.isEmpty) {
    return const PlatformClipboardAttachmentResult();
  }
  const channel = MethodChannel('dev.rnm.overseer/attachment-clipboard');
  final payload = await channel.invokeMapMethod<String, dynamic>('readUri', {
    'uri': uri,
    'mimeType': mimeType,
    'maxBytes': maxBytes,
  });
  return _resultFromPayload(payload);
}

PlatformClipboardAttachmentResult _resultFromPayload(
  Map<String, dynamic>? payload,
) {
  final rawAttachments = payload?['attachments'];
  return PlatformClipboardAttachmentResult(
    attachments: rawAttachments is List
        ? rawAttachments
              .whereType<Map>()
              .map(
                (raw) => PlatformClipboardAttachment(
                  name: raw['name'] as String? ?? 'pasted-file',
                  type: raw['type'] as String? ?? 'file',
                  bytes: raw['bytes'] as Uint8List,
                ),
              )
              .toList(growable: false)
        : const [],
    skippedTooLarge: payload?['skippedTooLarge'] as int? ?? 0,
    skippedForLimit: payload?['skippedForLimit'] as int? ?? 0,
  );
}

bool _isImageName(String name) {
  final lower = name.toLowerCase();
  return const ['.png', '.jpg', '.jpeg', '.gif', '.webp'].any(lower.endsWith);
}
