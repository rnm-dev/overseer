import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { FolderTree } from "lucide-react";
import { Link } from "react-router-dom";
import { useT } from "../../../i18n";
import { ConfirmationDialog, FixedPaneHeader, titleize } from "../../../ui";
import { compactNum, type UsageBreakdown } from "./parsing";
import { SessionPresence } from "../../../components/SessionPresence";
import type { PresenceUser } from "../../../liveSocket";

interface Props {
  peonId: string;
  projectKey: string | null;
  title: string | null;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  editing: boolean;
  setEditing: Dispatch<SetStateAction<boolean>>;
  savingName: boolean;
  renameNote: string | null;
  setRenameNote: Dispatch<SetStateAction<string | null>>;
  firstUserMessage: string | null;
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

export function SessionHeader(props: Props) {
  const {
    peonId, projectKey, title, draft, setDraft, editing, setEditing,
    savingName, renameNote, setRenameNote, firstUserMessage, turnTotal,
    usageSummary, filesOpen, changeFilesOpen, confirmDelete, setConfirmDelete,
    deleting, deleteNote, setDeleteNote, stopNote, saveName, cancelRename, remove, viewers,
  } = props;
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const showHeaderStats = turnTotal > 0 || !!usageSummary;

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
<FixedPaneHeader>
  <div className="space-y-1.5 px-3 py-2.5 sm:px-6">
    <div className="flex items-center gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
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
            placeholder={firstUserMessage || t("session.untitled")}
            aria-label={t("session.renamePlaceholder")}
            title={title ?? firstUserMessage ?? undefined}
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
      </div>

      {showHeaderStats && (
        <div className="hidden flex-none items-center gap-1.5 whitespace-nowrap font-mono text-xs text-bone-faint sm:flex">
          {turnTotal > 0 && <span>{t("session.chat.turns", { n: turnTotal })}</span>}
          {turnTotal > 0 && usageSummary && <span>·</span>}
          {usageSummary?.costUsd !== undefined && <span>${usageSummary.costUsd.toFixed(2)}</span>}
          {usageSummary?.costUsd !== undefined && usageSummary.output > 0 && <span>·</span>}
          {usageSummary && usageSummary.output > 0 && (
            <span
              title={`${t("peon.stats.inputTokens")} ${compactNum.format(usageSummary.input)} · ${t("peon.stats.cacheWrite")} ${compactNum.format(usageSummary.cacheCreate)} · ${t("peon.stats.cacheRead")} ${compactNum.format(usageSummary.cacheRead)}`}
            >
              {compactNum.format(usageSummary.output)} {t("peon.stats.outputTokens").toLowerCase()}
            </span>
          )}
        </div>
      )}

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

      <div className="relative flex-none" ref={menuRef}>
        <button
          type="button"
          title={t("session.menu")}
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
          <div className="absolute right-0 top-full z-30 mt-1 w-40 overflow-hidden rounded-lg border border-iron-800 bg-iron-950 py-1 shadow-lg">
            <button
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
    </div>

    {confirmDelete && <ConfirmationDialog title={t("session.delete.confirm")} confirmLabel={t("session.delete.confirmYes")} pendingLabel={t("session.delete.deleting")} pending={deleting} onClose={() => setConfirmDelete(false)} onConfirm={() => void remove()} />}
    {renameNote && <div className="font-mono text-xs text-blood">{renameNote}</div>}
    {deleteNote && <div className="font-mono text-xs text-blood">⚠ {deleteNote}</div>}
    {stopNote && <div className="font-mono text-xs text-ember">⚠ {stopNote}</div>}
  </div>
</FixedPaneHeader>
  );
}
