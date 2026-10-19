import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { useLiveSocket } from "../../realtime/liveSocket";
import { activeMentionQuery, insertMention, remapMentions, removeMention, type ComposerMention, type MentionPrincipal } from "./contextMentions";
import type { Ev } from "./parsing";
import { api } from "../../shared/api";
import { sessionPath } from "./sessionApi";

interface Args {
  base: string;
  sid: string;
  peonId: string;
  supported: boolean;
  subscribeMentionAttention: ReturnType<typeof useLiveSocket>["subscribeMentionAttention"];
  visibleEvents: readonly Ev[];
}

/**
 * The mention roster, the selected mentions, and unread mention attention for
 * the rendered transcript (acknowledged as soon as it is on screen).
 */
export function useComposerMentions({ base, sid, peonId, supported, subscribeMentionAttention, visibleEvents }: Args) {
  const [principals, setPrincipals] = useState<MentionPrincipal[]>([]);
  const [mentions, setMentions] = useState<ComposerMention[]>([]);
  const [attentionIds, setAttentionIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!supported) {
      setPrincipals([]);
      setMentions([]);
      setAttentionIds(new Set());
      return;
    }
    let alive = true;
    void Promise.all([
      api<{ principals?: MentionPrincipal[] }>(sessionPath(base, sid, "/mention-principals")),
      api<{ attention?: Array<{ eventId: string; unread: boolean }> }>(sessionPath(base, sid, "/mention-attention")),
    ]).then(([roster, attention]) => {
      if (!alive) return;
      setPrincipals(roster.principals ?? []);
      setAttentionIds(new Set((attention.attention ?? []).filter((item) => item.unread).map((item) => item.eventId)));
    }).catch(() => undefined);
    const unsubscribe = subscribeMentionAttention((attention) => {
      if (attention.peonId !== peonId || attention.sessionId !== sid) return;
      setAttentionIds((current) => {
        const next = new Set(current);
        if (attention.unread) next.add(attention.eventId); else next.delete(attention.eventId);
        return next;
      });
    });
    return () => { alive = false; unsubscribe(); };
  }, [base, supported, peonId, sid, subscribeMentionAttention]);

  useEffect(() => {
    if (!supported || attentionIds.size === 0 || document.visibilityState !== "visible") return;
    const rendered = visibleEvents.flatMap((event) => typeof event.eventId === "string" && attentionIds.has(event.eventId) ? [event.eventId] : []);
    if (rendered.length === 0) return;
    void api(sessionPath(base, sid, "/mention-attention/read"), { method: "POST", body: JSON.stringify({ eventIds: rendered.slice(0, 100) }) }).then(() => {
      setAttentionIds((current) => new Set([...current].filter((id) => !rendered.includes(id))));
    }).catch(() => undefined);
  }, [base, supported, attentionIds, sid, visibleEvents]);

  return { principals, mentions, setMentions };
}

interface PickerArgs {
  supported: boolean;
  principals: readonly MentionPrincipal[];
  mentions: ComposerMention[];
  setMentions: (mentions: ComposerMention[] | ((current: ComposerMention[]) => ComposerMention[])) => void;
  input: string;
  setInput: (value: string) => void;
}

/** The `@` picker bound to the composer's text and caret. */
export function useMentionPicker({ supported, principals, mentions, setMentions, input, setInput }: PickerArgs) {
  // Where the picker looks for its `@`, and where the caret is put back after a
  // person is inserted into the middle of an already written sentence.
  const [composerCaret, setComposerCaret] = useState<number | null>(null);
  const [caretRequest, setCaretRequest] = useState<{ position: number; seq: number } | null>(null);
  const caretSeqRef = useRef(0);

  const mentionQuery = supported ? activeMentionQuery(input, composerCaret ?? input.length) : null;
  const mentionSuggestions = useMemo(() => {
    if (!mentionQuery) return [];
    const query = mentionQuery.query.toLowerCase();
    return principals.filter((principal) => principal.label.toLowerCase().includes(query)).slice(0, 8);
  }, [principals, mentionQuery]);
  const changeComposerInput = useCallback((value: string, caret?: number) => {
    setComposerCaret(caret ?? null);
    setInput(value);
    setMentions((current) => remapMentions(input, value, current));
  }, [input, setInput, setMentions]);
  const selectMention = useCallback((principal: MentionPrincipal) => {
    const query = activeMentionQuery(input, composerCaret ?? input.length);
    if (!query) return;
    const selected = insertMention(input, query, principal, mentions);
    const caret = query.startUtf16 + principal.label.length + 2;
    setInput(selected.text);
    setMentions(selected.mentions);
    setComposerCaret(caret);
    setCaretRequest({ position: caret, seq: caretSeqRef.current++ });
  }, [composerCaret, input, mentions, setInput, setMentions]);
  const removeSelectedMention = useCallback((mention: ComposerMention) => {
    const removed = removeMention(input, mentions, mention);
    setInput(removed.text);
    setMentions(removed.mentions);
    setComposerCaret(mention.startUtf16);
    setCaretRequest({ position: mention.startUtf16, seq: caretSeqRef.current++ });
  }, [input, mentions, setInput, setMentions]);

  return { mentionQuery, mentionSuggestions, changeComposerInput, selectMention, removeSelectedMention, caretRequest };
}
