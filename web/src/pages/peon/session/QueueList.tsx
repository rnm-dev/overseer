import { Hourglass, Send, Trash2 } from "lucide-react";
import { attachmentLabel, type QueueItem } from "./queue";
import type { Translate } from "../../../i18n";

export function QueueList({ items, removing, sending, onRemove, onSendNow, t }: {
  items: QueueItem[];
  removing: ReadonlySet<string>;
  sending: ReadonlySet<string>;
  onRemove: (id: string) => void;
  onSendNow: (id: string) => void;
  t: Translate;
}) {
  if (!items.length) return null;
  return (
    <section className="mb-3" aria-label={t("session.queue.title")}>
      <ol className="max-h-56 space-y-2 overflow-y-auto">
        {items.map((item) => (
          <li key={item.id} className="ml-auto flex min-w-0 max-w-[80%] items-start gap-2 rounded-xl rounded-br-sm border border-fel/25 bg-fel/[0.12] px-3 py-2 shadow-lg backdrop-blur">
            <Hourglass
              size={13}
              strokeWidth={1.75}
              className={`mt-1 shrink-0 ${sending.has(item.id) ? "animate-pulse text-ember" : "text-fel-bright"}`}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="whitespace-pre-wrap break-words text-sm leading-normal text-bone">{item.prompt}</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-bone-faint">
                {item.author && <span>@{item.author}</span>}
                {(item.attachments ?? []).map((attachment, attachmentIndex) => (
                  <span key={`${attachment.path ?? attachment.name ?? "attachment"}:${attachmentIndex}`}>📎 {attachmentLabel(attachment)}</span>
                ))}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                className="flex size-9 items-center justify-center rounded-md text-xs font-medium text-ember transition-colors hover:bg-ember/10 disabled:cursor-wait disabled:opacity-40 sm:w-auto sm:gap-1.5 sm:px-2"
                disabled={sending.has(item.id) || removing.has(item.id)}
                onClick={() => onSendNow(item.id)}
                title={t("session.queue.sendNow")}
                aria-label={t("session.queue.sendNow")}
              >
                <Send size={15} className={sending.has(item.id) ? "animate-pulse" : undefined} aria-hidden />
                <span className="hidden sm:inline">{t("session.queue.sendNow")}</span>
              </button>
              <button
                type="button"
                className="grid size-9 place-items-center rounded-md text-bone-faint transition-colors hover:bg-blood/10 hover:text-blood disabled:cursor-wait disabled:opacity-40"
                disabled={removing.has(item.id) || sending.has(item.id)}
                onClick={() => onRemove(item.id)}
                title={t("session.queue.remove")}
                aria-label={t("session.queue.remove")}
              >
                {removing.has(item.id) ? "…" : <Trash2 size={20} aria-hidden />}
              </button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
