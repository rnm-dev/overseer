import { useCallback, useEffect, useState, type SetStateAction } from "react";
import type { MessageAttachment } from "./parsing";

const DRAFT_PREFIX = "overseer:composer-draft";
// Attachments a draft carries by path — already committed on the peon, so
// unlike a picked File they are a few bytes of JSON and belong next to the text
// half rather than in IndexedDB.
const CARRIED_SUFFIX = ":carried";

// Attachments cannot ride in localStorage next to the text — a File is not
// serialisable and a single one may be 25 MB. IndexedDB stores File objects
// natively (structured clone) and has a real quota, so drafted attachments
// survive a session switch or a reload just like the text does.
const FILE_DB_NAME = "overseer-composer-drafts";
const FILE_STORE = "attachments";
// A draft nobody comes back to would otherwise pin its bytes forever.
const FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const NO_FILES: File[] = [];

interface StoredDraftFiles {
  files: File[];
  updatedAt: number;
}

function readDraft(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(key: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Draft persistence is best-effort when storage is disabled or full.
  }
}

let fileDbPromise: Promise<IDBDatabase | null> | null = null;

// Resolves to null — never rejects — whenever IndexedDB is unavailable (SSR,
// private mode, blocked upgrade). Callers then simply keep drafts in memory.
function openFileDb(): Promise<IDBDatabase | null> {
  if (fileDbPromise) return fileDbPromise;
  fileDbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const request = indexedDB.open(FILE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(FILE_STORE)) request.result.createObjectStore(FILE_STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        resolve(db);
        pruneDraftFiles(db);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return fileDbPromise;
}

// Drop drafts nobody has touched in a week. Fire-and-forget: a failed prune only
// means the bytes stay a little longer.
function pruneDraftFiles(db: IDBDatabase): void {
  try {
    const cutoff = Date.now() - FILE_TTL_MS;
    const cursorRequest = db.transaction(FILE_STORE, "readwrite").objectStore(FILE_STORE).openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      const record = cursor.value as StoredDraftFiles | undefined;
      if (!record || !(record.updatedAt > cutoff)) cursor.delete();
      cursor.continue();
    };
  } catch {
    // Best-effort, same as every other draft write.
  }
}

async function readDraftFiles(key: string): Promise<File[]> {
  const db = await openFileDb();
  if (!db) return NO_FILES;
  return new Promise<File[]>((resolve) => {
    try {
      const request = db.transaction(FILE_STORE, "readonly").objectStore(FILE_STORE).get(key);
      request.onsuccess = () => {
        const record = request.result as StoredDraftFiles | undefined;
        const files = record?.files?.filter((file) => file instanceof File) ?? [];
        resolve(files.length ? files : NO_FILES);
      };
      request.onerror = () => resolve(NO_FILES);
    } catch {
      resolve(NO_FILES);
    }
  });
}

async function writeDraftFiles(key: string, files: File[]): Promise<void> {
  const db = await openFileDb();
  if (!db) return;
  try {
    const store = db.transaction(FILE_STORE, "readwrite").objectStore(FILE_STORE);
    if (files.length) store.put({ files, updatedAt: Date.now() } satisfies StoredDraftFiles, key);
    else store.delete(key);
  } catch {
    // Quota or a serialisation refusal — the attachments stay in memory only.
  }
}

export function composerDraftKey(workspaceId: string, peonId: string, sessionId: string | null): string {
  const scope = sessionId || "new-session";
  return [DRAFT_PREFIX, workspaceId, peonId, scope].map(encodeURIComponent).join(":");
}

// Write a draft straight to storage instead of through the hooks below. Their
// attachment half persists from an effect, which is fine while the composer
// stays mounted — but a composer that navigates away on submit unmounts before
// that effect could run, and a send that fails after the operator moved on has
// no mounted composer at all.
export function saveComposerDraft(key: string, value: string, files: File[], carried: readonly MessageAttachment[] = []): void {
  writeDraft(key, value);
  writeCarriedAttachments(key, carried);
  void writeDraftFiles(key, files);
}

export function clearComposerDraft(key: string): void {
  saveComposerDraft(key, "", NO_FILES);
}

// A new-session form deliberately does not revive file attachments. Unlike
// text, files are an explicit send-time choice: restoring them makes a prior
// paste look like the browser has pasted the current system clipboard. Keep
// this separate from clearComposerDraft so its text draft can still survive.
export function clearComposerDraftFiles(key: string): void {
  void writeDraftFiles(key, NO_FILES);
}

const NO_CARRIED: MessageAttachment[] = [];

function isCarried(value: unknown): value is MessageAttachment {
  return Boolean(value) && typeof value === "object" && typeof (value as MessageAttachment).path === "string";
}

export function readCarriedAttachments(key: string): MessageAttachment[] {
  try {
    const raw = window.localStorage.getItem(key + CARRIED_SUFFIX);
    if (!raw) return NO_CARRIED;
    const parsed: unknown = JSON.parse(raw);
    const carried = Array.isArray(parsed) ? parsed.filter(isCarried) : [];
    return carried.length ? carried : NO_CARRIED;
  } catch {
    return NO_CARRIED;
  }
}

export function writeCarriedAttachments(key: string, carried: readonly MessageAttachment[]): void {
  try {
    if (carried.length) window.localStorage.setItem(key + CARRIED_SUFFIX, JSON.stringify(carried));
    else window.localStorage.removeItem(key + CARRIED_SUFFIX);
  } catch {
    // Best-effort, like every other draft write.
  }
}

// The text half and the carried half are one draft: a session switch or a
// reload must show both or neither.
export function useCarriedAttachments(key: string): [MessageAttachment[], (carried: MessageAttachment[]) => void] {
  const [draft, setDraft] = useState(() => ({ key, carried: readCarriedAttachments(key) }));

  useEffect(() => {
    if (draft.key !== key) setDraft({ key, carried: readCarriedAttachments(key) });
  }, [draft.key, key]);

  const setCarried = useCallback((carried: MessageAttachment[]) => {
    writeCarriedAttachments(key, carried);
    setDraft({ key, carried });
  }, [key]);

  return [draft.key === key ? draft.carried : readCarriedAttachments(key), setCarried];
}

export function useComposerDraft(key: string, initialValue?: string, persist = true): [string, (value: string) => void] {
  const [draft, setDraft] = useState(() => ({ key, value: initialValue ?? readDraft(key) }));

  // React Router can reuse the session detail component when only :sid changes.
  // Load the new session's draft instead of carrying the previous input across.
  useEffect(() => {
    if (draft.key !== key) setDraft({ key, value: readDraft(key) });
  }, [draft.key, key]);

  const setValue = useCallback((value: string) => {
    if (persist) writeDraft(key, value);
    setDraft({ key, value });
  }, [key, persist]);

  // Avoid rendering the previous session's text during the route-change render.
  return [draft.key === key ? draft.value : readDraft(key), setValue];
}

// The attachment half of a draft, keyed exactly like the text half. Reads are
// async (IndexedDB), so the composer starts empty and adopts the stored set once
// it arrives — anything the operator attached in the meantime wins.
export function useComposerDraftFiles(key: string, restore = true): [File[], (files: SetStateAction<File[]>) => void] {
  const [draft, setDraft] = useState(() => ({ key, files: NO_FILES, loaded: false }));

  useEffect(() => {
    let alive = true;
    setDraft((current) => (current.key === key ? current : { key, files: NO_FILES, loaded: false }));
    if (!restore) {
      clearComposerDraftFiles(key);
      setDraft({ key, files: NO_FILES, loaded: true });
      return () => {
        alive = false;
      };
    }
    void readDraftFiles(key).then((files) => {
      if (!alive) return;
      setDraft((current) => (current.key === key && !current.loaded
        ? { key, files: current.files.length ? current.files : files, loaded: true }
        : current));
    });
    return () => {
      alive = false;
    };
  }, [key, restore]);

  // Persist the committed set rather than writing inside the setter, so a
  // React 18 double-invoked updater cannot double-write. Held back until the
  // stored set has been read, or the initial empty state would erase it.
  useEffect(() => {
    if (draft.key !== key || !draft.loaded) return;
    void writeDraftFiles(key, draft.files);
  }, [draft, key]);

  const setFiles = useCallback((action: SetStateAction<File[]>) => {
    setDraft((current) => {
      const base = current.key === key ? current.files : NO_FILES;
      const files = typeof action === "function" ? action(base) : action;
      return { key, files, loaded: true };
    });
  }, [key]);

  // Like the text half: never render the previous session's attachments during
  // the route-change render.
  return [draft.key === key ? draft.files : NO_FILES, setFiles];
}
