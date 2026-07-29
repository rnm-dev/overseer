(function () {
  const { useState, useRef, useEffect } = React;
  const { Button, ProgressBar, formatBytes } = window.ACA;

  // Keep in sync with src/daemon/uploads.ts's ATTACHMENTS_MAX_FILE_BYTES/
  // ATTACHMENTS_MAX_COUNT — this codebase already duplicates small config
  // values across the no-bundler frontend/backend boundary (e.g. the
  // dashboard port is independently hardcoded in both controlServer.ts and
  // dashboard/server.ts), so this isn't a new pattern. Client-side
  // enforcement is just for immediate feedback; the server enforces its own
  // copy of these limits regardless.
  const MAX_FILE_BYTES = 25 * 1024 * 1024;
  const MAX_COUNT = 10;

  function extensionFor(mimetype) {
    const known = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
    return known[mimetype] || "bin";
  }

  // Client-side-only thumbnail via a blob URL — a staging-area nicety,
  // revoked on unmount to avoid leaking object URLs. Does not apply to the
  // persisted transcript view (that would need a new file-serving route —
  // out of scope for this pass).
  function Thumb({ file }) {
    const [url, setUrl] = useState(null);
    useEffect(() => {
      const u = URL.createObjectURL(file);
      setUrl(u);
      return () => URL.revokeObjectURL(u);
    }, [file]);
    return url ? <img src={url} className="h-6 w-6 rounded object-cover" /> : null;
  }

  // Staged item shape: { id, file, name }. Pasted image blobs are wrapped in
  // a real File immediately on paste so every downstream consumer only ever
  // deals in File objects, whatever the source (picker/drop/paste).
  function AttachmentPicker({ items, onChange, disabled, uploadProgress }) {
    const inputRef = useRef(null);
    const dropRef = useRef(null);
    const [rejectMsg, setRejectMsg] = useState(null);

    const add = (fileList) => {
      const incoming = Array.from(fileList);
      const oversized = incoming.filter((f) => f.size > MAX_FILE_BYTES);
      const room = Math.max(0, MAX_COUNT - items.length);
      const withinSize = incoming.filter((f) => f.size <= MAX_FILE_BYTES);
      const accepted = withinSize.slice(0, room);
      const droppedForCount = withinSize.length - accepted.length;

      if (oversized.length > 0) {
        setRejectMsg(`${oversized.length} file(s) too large (max ${formatBytes(MAX_FILE_BYTES)} each) — not attached`);
      } else if (droppedForCount > 0) {
        setRejectMsg(`only ${MAX_COUNT} files allowed per message — ${droppedForCount} not attached`);
      } else {
        setRejectMsg(null);
      }

      if (accepted.length === 0) return;
      const next = accepted.map((file) => ({ id: `${Date.now()}-${Math.random()}`, file, name: file.name }));
      onChange([...items, ...next]); // append, no dedupe by name+size — see AttachmentPicker plan notes
    };

    const remove = (id) => onChange(items.filter((it) => it.id !== id));

    useEffect(() => {
      // Listen on document, not just the picker's own div: users paste with
      // the cursor in the compose textarea/input (a sibling), so a paste
      // never reaches the picker element. A non-file paste (plain text) is
      // ignored here, so this doesn't interfere with typing into a field.
      const onPaste = (e) => {
        if (disabled) return;
        const fileItems = Array.from(e.clipboardData?.items ?? []).filter((it) => it.kind === "file");
        if (fileItems.length === 0) return;
        const files = fileItems
          .map((it, i) => {
            const blob = it.getAsFile();
            return blob ? new File([blob], `pasted-image-${Date.now()}-${i}.${extensionFor(blob.type)}`, { type: blob.type }) : null;
          })
          .filter(Boolean);
        if (files.length > 0) add(files);
      };
      document.addEventListener("paste", onPaste);
      return () => document.removeEventListener("paste", onPaste);
    }, [items, disabled]);

    return (
      <div
        ref={dropRef}
        tabIndex={0}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (!disabled) add(e.dataTransfer.files);
        }}
        className="space-y-2 rounded border border-dashed border-slate-700 p-2 outline-none focus:border-brand-500"
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-slate-500">Drag &amp; drop, paste, or</p>
          <Button variant="ghost" disabled={disabled} onClick={() => inputRef.current?.click()}>
            Attach files
          </Button>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              add(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        {items.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {items.map((it) => (
              <li key={it.id} className="flex items-center gap-2 rounded bg-slate-800 px-2 py-1 text-xs text-slate-300">
                {it.file.type.startsWith("image/") && <Thumb file={it.file} />}
                <span className="max-w-[10rem] truncate">{it.name}</span>
                <span className="text-slate-500">{formatBytes(it.file.size)}</span>
                {!disabled && (
                  <button type="button" onClick={() => remove(it.id)} className="text-slate-500 hover:text-slate-200">
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {uploadProgress != null && <ProgressBar value={uploadProgress} />}
        {rejectMsg && <p className="text-xs text-red-400">✗ {rejectMsg}</p>}
      </div>
    );
  }

  window.ACA.AttachmentPicker = AttachmentPicker;
})();
