import type { MessageAttachment } from "./parsing";

export type AttachmentPreviewKind = "image" | "pdf" | "text" | "unsupported";

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i;
const TEXT_EXTENSION = /\.(?:txt|md|json|ya?ml|csv|log|tsx?|jsx?|css|html?|py|go|rs|java|sh)$/i;

// Peon's transfer sandbox stores every upload as application/octet-stream.
// Use the attachment metadata and filename as fallbacks to the response MIME
// type so sent-message attachments remain previewable after a transcript reload.
export function attachmentPreviewKind(attachment: MessageAttachment, contentType: string, name: string): AttachmentPreviewKind {
  const mime = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (attachment.type === "image" || mime.startsWith("image/") || IMAGE_EXTENSION.test(name)) return "image";
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (mime.startsWith("text/") || TEXT_EXTENSION.test(name)) return "text";
  return "unsupported";
}
