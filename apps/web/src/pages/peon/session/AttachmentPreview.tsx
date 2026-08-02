import { Dialog } from "../../../ui";
import { FileDownloadButton, FileView, useFileContent } from "../FileView";
import { fileName, type FileSource } from "../fileLinks";
import type { MessageAttachment } from "./parsing";

export function AttachmentPreview({ base, attachment, onClose }: { base: string; attachment: MessageAttachment; onClose: () => void }) {
  const name = attachment.name || (attachment.path ? fileName(attachment.path) : "attachment");
  // A message the operator did not just send carries the Peon's absolute path;
  // the attachment source maps it back into the file transfer sandbox.
  const source: FileSource = { kind: "attachment", base, path: attachment.path || "" };
  const content = useFileContent({
    source,
    size: attachment.size,
    hint: attachment.type === "image" ? "image" : undefined,
    enabled: !!attachment.path,
  });

  return (
    <Dialog title={name} onClose={onClose} size="lg" actions={attachment.path ? <FileDownloadButton source={source} /> : undefined}>
      <div className="surface surface--inset max-h-[75vh] overflow-auto">
        <FileView content={content} />
      </div>
    </Dialog>
  );
}
