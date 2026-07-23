import { useEffect, useState } from "react";
import { getToken } from "../../../api";
import { Dialog } from "../../../ui";
import type { MessageAttachment } from "./parsing";
import { attachmentPreviewKind, type AttachmentPreviewKind } from "./attachmentPreviewKind";

export function AttachmentPreview({ base, attachment, onClose }: { base: string; attachment: MessageAttachment; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [mediaKind, setMediaKind] = useState<Extract<AttachmentPreviewKind, "image" | "pdf"> | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = attachment.name || attachment.path?.split(/[\\/]/).pop() || "attachment";

  useEffect(() => {
    if (!attachment.path) return;
    const ctrl = new AbortController();
    let objectUrl: string | null = null;
    const token = getToken();
    fetch(`/api${base}/files/${attachment.path.split("/").map(encodeURIComponent).join("/")}`, {
      signal: ctrl.signal,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }).then(async (res) => {
      if (!res.ok) throw new Error(`Preview failed (${res.status})`);
      const blob = await res.blob();
      const kind = attachmentPreviewKind(attachment, blob.type, name);
      if (kind === "image" || kind === "pdf") {
        objectUrl = URL.createObjectURL(blob);
        setMediaKind(kind);
        setUrl(objectUrl);
      } else if (kind === "text") {
        setText(await blob.text());
      } else setError("This binary format cannot be previewed.");
    }).catch((err) => { if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : String(err)); });
    return () => { ctrl.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [attachment, attachment.path, attachment.type, base, name]);

  return (
    <Dialog title={name} onClose={onClose} size="lg">
      <div className="surface surface--inset max-h-[75vh] overflow-auto">
        {!url && text === null && !error && <div className="grid h-40 place-items-center"><div className="forge-spin" /></div>}
        {error && <p className="p-4 font-mono text-sm text-blood">{error}</p>}
        {url && (mediaKind === "pdf" ? <iframe src={url} title={name} className="h-[70vh] w-full" /> : <img src={url} alt={name} className="mx-auto max-h-[70vh] max-w-full" />)}
        {text !== null && <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs text-bone">{text}</pre>}
      </div>
    </Dialog>
  );
}
