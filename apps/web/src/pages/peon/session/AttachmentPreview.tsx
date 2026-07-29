import { Dialog } from "../../../ui";
import { FileView, useFileContent } from "../FileView";
import { fileName } from "../fileLinks";
import type { MessageAttachment } from "./parsing";

export function AttachmentPreview({ base, attachment, onClose }: { base: string; attachment: MessageAttachment; onClose: () => void }) {
  const name = attachment.name || (attachment.path ? fileName(attachment.path) : "attachment");
  // A message the operator did not just send carries the Peon's absolute path;
  // the attachment source maps it back into the file transfer sandbox.
  const content = useFileContent({
    source: { kind: "attachment", base, path: attachment.path || "" },
    size: attachment.size,
    hint: attachment.type === "image" ? "image" : undefined,
    enabled: !!attachment.path,
  });

  return (
    <Dialog title={name} onClose={onClose} size="lg">
      <div className="surface surface--inset max-h-[75vh] overflow-auto">
        <FileView content={content} />
      </div>
    </Dialog>
  );
}
