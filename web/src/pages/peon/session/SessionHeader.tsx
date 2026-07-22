import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { FolderTree } from "lucide-react";
import { Link } from "react-router-dom";
import { useT } from "../../../i18n";
import { ConfirmationDialog, FixedPaneHeader, titleize } from "../../../ui";
import { compactNum, type UsageBreakdown } from "./parsing";
import { SessionPresence } from "../../../components/SessionPresence";
import type { PresenceUser } from "../../../liveSocket";
import { MOBILE_SESSION_HEADER_ID } from "./mobileHeader";

interface Props {
  peonId: string;
  metadataLoading: boolean;
  projectKey: string | null;
  title: string | null;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  editing: boolean;
  setEditing: Dispatch<SetStateAction<boolean>>;
  savingName: boolean;
  renameNote: string | null;
  setRenameNote: Dispatch<SetStateAction<string | null>>;
  openingMessage: string | null;
  turnTotal: number;
  usageSummary: UsageBreakdown | null;
  filesOpen: boolean;
  changeFilesOpen: (open: boolean) => void;
  confirmDelete: boolean;
  setConfirmDelete: Dispatch<SetStateAction<boolean>>;
  deleting: boolean;
  deleteNote: string | null;
  setDeleteNote: Dispatch<SetStateAction<string | null>>;
  stopNote: string | null;
  saveName: () => Promise<void>;
  cancelRename: () => void;
  remove: () => Promise<void>;
  viewers: PresenceUser[];
}

interface SessionHeaderIdentityProps {
  peonId: string;
  metadataLoading: boolean;
  projectKey: string | null;
  title: string | null;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  editing: boolean;
  setEditing: Dispatch<SetStateAction<boolean>>;
  savingName: boolean;
  setRenameNote: Dispatch<SetStateAction<string | null>>;
  openingMessage: string | null;
  saveName: () => Promise<void>;
  cancelRename: () => void;
}

export function sessionHeaderMetadataLoading(
  loadedMetadataKey: string | null,
  sessionKey: string,
  title: string | null,
  openingMessage: string | null,
): boolean {
  return loadedMetadataKey !== sessionKey || (!title && !openingMessage);
}

export function SessionHeaderStats({ turnTotal, usageSummary }: { turnTotal: number; usageSummary: UsageBreakdown | null }) {
  const t = useT();
  if (turnTotal <= 0 && !usageSummary) return null;

  return (
    <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap font-mono text-[0.62rem] text-bone-faint sm:text-xs">
      {turnTotal > 0 && <span>{t("session.chat.turns", { n: turnTotal })}</span>}
      {turnTotal > 0 && usageSummary && <span>·</span>}
      {usageSummary && (
        <span
          className="truncate"
          title={`${t("peon.stats.cacheWrite")} ${compactNum.format(usageSummary.cacheCreate)} · ${t("peon.stats.cacheRead")} ${compactNum.format(usageSummary.cacheRead)}`}
        >
          {compactNum.format(usageSummary.input)} {t("peon.stats.inputTokens").toLowerCase()}
        </span>
      )}
      {usageSummary && usageSummary.output > 0 && <span>·</span>}
      {usageSummary && usageSummary.output > 0 && (
        <span className="truncate">
          {compactNum.format(usageSummary.output)} {t("peon.stats.outputTokens").toLowerCase()}
        </span>
      )}
    </div>
  );
}

export function SessionHeaderIdentity({
  peonId, metadataLoading, projectKey, title, draft, setDraft, editing,
  setEditing, savingName, setRenameNote, openingMessage, saveName, cancelRename,
}: SessionHeaderIdentityProps) {
  const t = useT();

  if (metadataLoading) {
    return (
      <div
        className="flex min-w-0 flex-1 items-center gap-2"
        role="status"
        aria-label={t("app.loading")}
        aria-busy="true"
      >
        <span className="h-3.5 w-16 flex-none animate-pulse rounded bg-iron-700/70 motion-reduce:animate-none" aria-hidden />
        <span className="h-3.5 w-44 max-w-[55%] animate-pulse rounded bg-iron-700/70 motion-reduce:animate-none" aria-hidden />
      </div>
    );
  }

  return (
    <>
      {projectKey && (
        <Link
          to={`/peons/${peonId}/projects/${encodeURIComponent(projectKey)}`}
          className="flex-none whitespace-nowrap font-display text-sm font-semibold text-forge transition-colors hover:text-fel-bright"
          title={t("session.project")}
        >
          {titleize(projectKey)}
        </Link>
      )}
      <div
        className={`flex min-w-0 flex-1 items-center rounded transition-colors ${editing ? "bg-iron-800/70" : ""}`}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null) && !savingName) cancelRename();
        }}
      >
        <input
          value={draft}
          placeholder={openingMessage || t("session.untitled")}
          aria-label={t("session.renamePlaceholder")}
          title={title ?? openingMessage ?? undefined}
          disabled={savingName}
          onFocus={(e) => {
            setRenameNote(null);
            setEditing(true);
            e.currentTarget.select();
          }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void saveName();
            if (e.key === "Escape") cancelRename();
          }}
          className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 font-display text-sm font-semibold text-bone outline-none placeholder:text-bone placeholder:opacity-100 disabled:cursor-wait"
        />
        {editing && (
          <div className="ml-1 flex shrink-0 items-center gap-0.5 pr-0.5">
            <button
              type="button"
              className="grid size-5 place-items-center rounded text-xs text-fel-bright transition-colors hover:bg-fel/15 disabled:opacity-50"
              title={t("session.rename.save")}
              aria-label={t("session.rename.save")}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void saveName()}
              disabled={savingName}
            >
              ✓
            </button>
            <button
              type="button"
              className="grid size-5 place-items-center rounded text-sm text-bone-dim transition-colors hover:bg-iron-700 hover:text-bone disabled:opacity-50"
              title={t("action.cancel")}
              aria-label={t("action.cancel")}
              onMouseDown={(e) => e.preventDefault()}
              onClick={cancelRename}
              disabled={savingName}
            >
              ×
            </button>
          </div>
        )}
      </div>
    </>
  );
}

export function SessionHeader(props: Props) {
  const {
    peonId, metadataLoading, projectKey, title, draft, setDraft, editing, setEditing,
    savingName, renameNote, setRenameNote, openingMessage, turnTotal,
    usageSummary, filesOpen, changeFilesOpen, confirmDelete, setConfirmDelete,
    deleting, deleteNote, setDeleteNote, stopNote, saveName, cancelRename, remove, viewers,
  } = props;
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const desktopMenuRef = useRef<HTMLDivElement>(null);
  const [mobileHeaderNode, setMobileHeaderNode] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setMobileHeaderNode(document.getElementById(MOBILE_SESSION_HEADER_ID));
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!mobileMenuRef.current?.contains(target) && !desktopMenuRef.current?.contains(target)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const renderMenu = (ref: RefObject<HTMLDivElement>) => (
    <div className="relative flex-none" ref={ref}>
      <button
        type="button"
        title={t("session.menu")}
        aria-label={t("session.menu")}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((o) => !o)}
        className="flex items-center rounded p-1 text-bone-dim transition-colors hover:bg-iron-800 hover:text-bone"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="12" cy="5" r="1.75" />
          <circle cx="12" cy="12" r="1.75" />
          <circle cx="12" cy="19" r="1.75" />
        </svg>
      </button>
      {menuOpen && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-40 overflow-hidden rounded-lg border border-iron-800 bg-iron-950 py-1 shadow-lg">
          <button
            role="menuitem"
            className="block w-full px-3 py-1.5 text-left font-mono text-xs text-blood transition-colors hover:bg-blood/10"
            onClick={() => {
              setDeleteNote(null);
              setConfirmDelete(true);
              setMenuOpen(false);
            }}
          >
            {t("session.delete")}
          </button>
        </div>
      )}
    </div>
  );

  const identity = (
    <SessionHeaderIdentity
      peonId={peonId}
      metadataLoading={metadataLoading}
      projectKey={projectKey}
      title={title}
      draft={draft}
      setDraft={setDraft}
      editing={editing}
      setEditing={setEditing}
      savingName={savingName}
      setRenameNote={setRenameNote}
      openingMessage={openingMessage}
      saveName={saveName}
      cancelRename={cancelRename}
    />
  );

  return (
<>
  {mobileHeaderNode && createPortal(
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <div className="flex min-w-0 items-center gap-1.5">{identity}</div>
        <SessionHeaderStats turnTotal={turnTotal} usageSummary={usageSummary} />
      </div>
      <SessionPresence viewers={viewers} />
      {renderMenu(mobileMenuRef)}
    </div>,
    mobileHeaderNode,
  )}

  <FixedPaneHeader className="hidden md:block">
  <div className="space-y-1.5 px-3 py-2.5 sm:px-6">
    <div className="flex items-center gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {identity}
      </div>

      <div className="flex-none"><SessionHeaderStats turnTotal={turnTotal} usageSummary={usageSummary} /></div>

      <SessionPresence viewers={viewers} />

      <button
        type="button"
        title={t("session.files.open")}
        aria-label={t("session.files.open")}
        aria-expanded={filesOpen}
        onClick={() => changeFilesOpen(!filesOpen)}
        className={`hidden size-7 flex-none place-items-center rounded transition-colors lg:grid ${filesOpen ? "bg-iron-800 text-fel-bright" : "text-bone-dim hover:bg-iron-800 hover:text-bone"}`}
      >
        <FolderTree size={16} aria-hidden />
      </button>

      {renderMenu(desktopMenuRef)}
    </div>

    {confirmDelete && <ConfirmationDialog title={t("session.delete.confirm")} confirmLabel={t("session.delete.confirmYes")} pendingLabel={t("session.delete.deleting")} pending={deleting} onClose={() => setConfirmDelete(false)} onConfirm={() => void remove()} />}
    {renameNote && <div className="font-mono text-xs text-blood">{renameNote}</div>}
    {deleteNote && <div className="font-mono text-xs text-blood">⚠ {deleteNote}</div>}
    {stopNote && <div className="font-mono text-xs text-ember">⚠ {stopNote}</div>}
  </div>
</FixedPaneHeader>
  {(renameNote || deleteNote || stopNote) && (
    <div className="space-y-1 px-3 pt-2 font-mono text-xs md:hidden">
      {renameNote && <div className="text-blood">{renameNote}</div>}
      {deleteNote && <div className="text-blood">⚠ {deleteNote}</div>}
      {stopNote && <div className="text-ember">⚠ {stopNote}</div>}
    </div>
  )}
</>
  );
}
