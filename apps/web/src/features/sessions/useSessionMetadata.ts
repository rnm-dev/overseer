import { useCallback, useEffect, useState } from "react";
import { sessionLineage } from "./sessionBranch";
import { getSession, type SessionRecord } from "./sessionApi";

export interface SessionLineage {
  sourceSessionId: string;
  relation: "branch" | "subsession";
  title: string | null;
}

/** What the page knows from the session record; filled by one fetch. */
export interface SessionMetadata {
  /** The session key whose record was loaded last, or null before the first. */
  loadedKey: string | null;
  title: string | null;
  openingMessage: string | null;
  projectKey: string | null;
  projectId: string | null;
  projectRoot: string | null;
  turnCount: number | null;
  usage: unknown;
  lineage: SessionLineage | null;
  // Session default model (null ⇒ follows the peon's global default).
  agent: string | null;
  model: string | null;
  reasoningEffort: string | null;
  permissionMode: string | null;
}

const EMPTY_METADATA: SessionMetadata = {
  loadedKey: null, title: null, openingMessage: null, projectKey: null, projectId: null, projectRoot: null,
  turnCount: null, usage: null, lineage: null, agent: null, model: null, reasoningEffort: null, permissionMode: null,
};

interface RunStatusSink {
  metadataRevision: () => number;
  applyMetadataStatus: (revision: number, record: SessionRecord) => void;
  applyMetadataFailure: (revision: number) => void;
}

interface Args {
  base: string;
  sid: string;
  sessionKey: string;
  /** Bumped to re-read the record (e.g. when a run ends). */
  metaTick: number;
  /** The indexed summary's title, mirrored into the header immediately. */
  indexedTitle: string | null | undefined;
  runState: RunStatusSink;
}

export function useSessionMetadata({ base, sid, sessionKey, metaTick, indexedTitle, runState }: Args) {
  const [metadata, setMetadata] = useState<SessionMetadata>(EMPTY_METADATA);
  // Inline rename state; the record resets it whenever it loads.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const setTitle = useCallback((title: string | null) => setMetadata((current) => ({ ...current, title })), []);

  // Sidebar mutations update the shared indexed summary immediately. Mirror a
  // renamed selected session into the header without waiting for the next
  // metadata refresh or durable catalog event.
  useEffect(() => {
    if (indexedTitle === undefined) return;
    setTitle(indexedTitle);
    if (!editing) setDraft(indexedTitle ?? "");
  }, [editing, indexedTitle, sessionKey, setTitle]);

  const { metadataRevision, applyMetadataStatus, applyMetadataFailure } = runState;
  useEffect(() => {
    let alive = true;
    const runRevision = metadataRevision();
    getSession(base, sid)
      .then((s) => {
        if (!alive) return;
        const source = sessionLineage(s);
        setMetadata({
          loadedKey: sessionKey,
          title: s.title ?? null,
          openingMessage: s.promptPreview?.trim() || s.prompt?.trim() || null,
          projectKey: s.projectKey ?? null,
          projectId: s.projectId ?? null,
          projectRoot: s.projectRoot ?? null,
          turnCount: typeof s.turnCount === "number" ? s.turnCount : null,
          usage: s.usage ?? null,
          lineage: source ? { ...source, title: null } : null,
          agent: s.agent ?? null,
          model: s.model ?? null,
          reasoningEffort: s.reasoningEffort ?? null,
          permissionMode: s.permissionMode ?? null,
        });
        setDraft(s.title ?? "");
        setEditing(false);
        applyMetadataStatus(runRevision, s);
      })
      .catch(() => {
        if (alive) applyMetadataFailure(runRevision);
      });
    return () => {
      alive = false;
    };
  }, [base, sid, sessionKey, metaTick, metadataRevision, applyMetadataStatus, applyMetadataFailure]);

  const lineage = metadata.lineage;
  useEffect(() => {
    if (!lineage?.sourceSessionId || lineage.title !== null) return;
    let alive = true;
    const setLineageTitle = (title: string) => setMetadata((current) => current.lineage?.sourceSessionId === lineage.sourceSessionId
      ? { ...current, lineage: { ...current.lineage, title } }
      : current);
    getSession(base, lineage.sourceSessionId)
      .then((source) => {
        if (alive) setLineageTitle(source.title?.trim() || source.promptPreview?.trim() || source.prompt?.trim() || lineage.sourceSessionId);
      })
      .catch(() => {
        if (alive) setLineageTitle(lineage.sourceSessionId);
      });
    return () => { alive = false; };
  }, [base, lineage]);

  return { metadata, setTitle, editing, setEditing, draft, setDraft };
}
