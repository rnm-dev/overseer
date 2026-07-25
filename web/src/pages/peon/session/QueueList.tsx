import { Hourglass, Send, Trash2 } from "lucide-react";
import { attachmentLabel, type QueueItem } from "./queue";
import type { Translate } from "../../../i18n";

export const QUEUE_ACTION_CLASS = "flex h-7 min-w-7 items-center justify-center rounded-md bg-black/10 text-[11px] font-medium text-white transition-colors hover:bg-black/20 hover:text-white disabled:cursor-wait disabled:opacity-40";
export const QUEUE_HOURGLASS_CLASS = "mt-1 shrink-0 text-ember/70";

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
          <li key={item.id} className="ml-auto flex w-full min-w-0 max-w-none items-start gap-2 rounded-xl rounded-br-sm bg-forge-deep/55 px-3 py-2 shadow-lg backdrop-blur-md md:w-auto md:max-w-[80%]">
            <Hourglass
              size={13}
              strokeWidth={1.75}
              className={`${QUEUE_HOURGLASS_CLASS} ${sending.has(item.id) ? "animate-pulse text-ember" : ""}`}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="whitespace-pre-wrap break-words text-sm leading-normal text-bone">{item.prompt}</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-body text-[11px] text-bone/60">
                {(item.attachments ?? []).map((attachment, attachmentIndex) => (
                  <span key={`${attachment.path ?? attachment.name ?? "attachment"}:${attachmentIndex}`}>📎 {attachmentLabel(attachment)}</span>
                ))}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                className={`${QUEUE_ACTION_CLASS} sm:gap-1 sm:px-2`}
                disabled={sending.has(item.id) || removing.has(item.id)}
                onClick={() => onSendNow(item.id)}
                title={t("session.queue.sendNow")}
                aria-label={t("session.queue.sendNow")}
              >
                <Send size={13} className={sending.has(item.id) ? "animate-pulse" : undefined} aria-hidden />
                <span className="hidden sm:inline">{t("session.queue.sendNow")}</span>
              </button>
              <button
                type="button"
                className={`${QUEUE_ACTION_CLASS} hover:bg-blood/15`}
                disabled={removing.has(item.id) || sending.has(item.id)}
                onClick={() => onRemove(item.id)}
                title={t("session.queue.remove")}
                aria-label={t("session.queue.remove")}
              >
                {removing.has(item.id) ? "…" : <Trash2 size={15} aria-hidden />}
              </button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
