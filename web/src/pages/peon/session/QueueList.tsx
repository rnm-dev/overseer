import { Trash2 } from "lucide-react";
import { attachmentLabel, type QueueItem } from "./queue";
import type { Translate } from "../../../i18n";

export function QueueList({ items, removing, onRemove, t }: {
  items: QueueItem[];
  removing: ReadonlySet<string>;
  onRemove: (id: string) => void;
  t: Translate;
}) {
  if (!items.length) return null;
  return (
    <section className="mb-3" aria-label={t("session.queue.title")}>
      <ol className="max-h-56 space-y-2 overflow-y-auto">
        {items.map((item) => (
          <li key={item.id} className="ml-auto flex min-w-0 max-w-[80%] items-start gap-2 rounded-xl rounded-br-sm border border-fel/25 bg-fel/[0.12] px-3 py-2 shadow-lg backdrop-blur">
            <div className="min-w-0 flex-1">
              <div className="whitespace-pre-wrap break-words text-sm leading-normal text-bone">{item.prompt}</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-bone-faint">
                {item.author && <span>@{item.author}</span>}
                {item.model && <span>{item.model}</span>}
                {item.reasoningEffort && <span>{t("session.queue.effort", { effort: item.reasoningEffort })}</span>}
                {item.permissionMode && <span>{item.permissionMode}</span>}
                {(item.attachments ?? []).map((attachment, attachmentIndex) => (
                  <span key={`${attachment.path ?? attachment.name ?? "attachment"}:${attachmentIndex}`}>📎 {attachmentLabel(attachment)}</span>
                ))}
              </div>
            </div>
            <button
              type="button"
              className="grid size-9 shrink-0 place-items-center rounded-md text-bone-faint transition-colors hover:bg-blood/10 hover:text-blood disabled:cursor-wait disabled:opacity-40"
              disabled={removing.has(item.id)}
              onClick={() => onRemove(item.id)}
              title={t("session.queue.remove")}
              aria-label={t("session.queue.remove")}
            >
              {removing.has(item.id) ? "…" : <Trash2 size={20} aria-hidden />}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
