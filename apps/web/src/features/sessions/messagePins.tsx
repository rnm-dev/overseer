import { useCallback, useEffect, useRef, useState } from "react";
import { Pin, PinOff, X } from "lucide-react";
import { api } from "../../shared/api";
import { useT } from "../../shared/i18n";
import { flattenEvents, type Ev, type Item } from "./parsing";
import { ItemView } from "./messageParts";

interface MessagePin { eventId: string; event: Ev; pinnedBy: string; createdAt: number }
export function useMessagePins(base: string, sid: string) {
  const endpoint = `${base}/sessions/${encodeURIComponent(sid)}/pins`;
  const [pins, setPins] = useState<MessagePin[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const busyRef = useRef(false);
  const load = useCallback(async () => {
    if (busyRef.current) return;
    const current = ++generation.current;
    try {
      const result = await api<{ pins: MessagePin[] }>(endpoint);
      if (current === generation.current && !busyRef.current) { setPins(result.pins); setError(""); }
    } catch (error) { if (current === generation.current) setError(String(error)); }
  }, [endpoint]);
  useEffect(() => {
    generation.current += 1;
    setPins([]); setError(""); setBusy(false); busyRef.current = false;
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    return () => { generation.current += 1; window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [load]);
  const toggle = async (eventId: string) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    const current = ++generation.current;
    try {
      const result = await api<{ pins: MessagePin[] }>(`${endpoint}/${encodeURIComponent(eventId)}`, { method: pins.some((pin) => pin.eventId === eventId) ? "DELETE" : "PUT" });
      if (current === generation.current) { setPins(result.pins); setError(""); }
    } catch (error) { if (current === generation.current) setError(String(error)); }
    finally { if (current === generation.current) { busyRef.current = false; setBusy(false); } }
  };
  return { pins, error, busy, toggle, load };
}
type PinsState = ReturnType<typeof useMessagePins>;
export function MessagePinAction({ item, state }: { item: Item; state: PinsState }) {
  const t = useT();
  if (!(item.kind === "user" || item.kind === "participant" || item.kind === "text") || !item.sourceEventId) return null;
  const eventId = item.sourceEventId;
  const pinned = state.pins.some((pin) => pin.eventId === eventId);
  return <div className="flex justify-end"><button type="button" disabled={state.busy} aria-pressed={pinned} title={t(pinned ? "session.pins.unpin" : "session.pins.pin")} aria-label={t(pinned ? "session.pins.unpin" : "session.pins.pin")} onClick={() => void state.toggle(eventId)} className={`rounded p-2 hover:bg-surface-hover ${pinned ? "text-accent-strong" : "text-ink-faint"}`}><Pin size={14} /></button></div>;
}
export function PinnedMessages({ state }: { state: PinsState }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return <div className="pointer-events-auto absolute right-3 top-14 z-30">
    <button type="button" className="flex items-center gap-2 rounded-lg border border-edge bg-surface px-3 py-2 text-xs text-ink" onClick={() => { setOpen(!open); void state.load(); }} aria-expanded={open}><Pin size={14} />{t("session.pins.title")} ({state.pins.length})</button>
    {state.error && <p role="alert" className="max-w-xs rounded bg-surface p-2 text-xs text-danger">{state.error}</p>}
    {open && <section aria-label={t("session.pins.title")} className="absolute right-0 mt-2 max-h-[65vh] w-[min(36rem,calc(100vw-1.5rem))] overflow-y-auto rounded-xl border border-edge bg-surface p-3 shadow-xl">
      <div className="flex justify-between text-ink"><strong>{t("session.pins.title")}</strong><button type="button" aria-label={t("session.pins.close")} onClick={() => setOpen(false)}><X size={18} /></button></div>
      {!state.pins.length && <p className="py-4 text-sm text-ink-muted">{t("session.pins.empty")}</p>}
      {state.pins.map((pin) => <article key={pin.eventId} className="border-b border-edge py-3">
        {flattenEvents([pin.event], t).filter((item) => item.kind === "user" || item.kind === "participant" || item.kind === "text").map((item) => <ItemView key={item.key} item={item} t={t} />)}
        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-ink-muted"><span>{t("session.pins.by", { name: pin.pinnedBy })}</span><button type="button" disabled={state.busy} onClick={() => void state.toggle(pin.eventId)} className="flex items-center gap-1 rounded p-2 hover:bg-surface-hover"><PinOff size={14} />{t("session.pins.unpin")}</button></div>
      </article>)}
    </section>}
  </div>;
}
