import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { BookOpen, FolderTree, Share2 } from "lucide-react";
import { useT } from "../../shared/i18n";
import { TOOLBAR_GROUP, toolbarItemClass, ConfirmationDialog, ContentHeader, ContentHeaderIdentitySkeleton, ContentHeaderLayout, ContentHeaderTitle, titleize } from "../../shared/ui";
import { compactNum, type UsageBreakdown } from "./parsing";
import { SessionPresence } from "./SessionPresence";
import type { PresenceUser } from "../../realtime/liveSocket";
import { MOBILE_CONTENT_HEADER_ID } from "./mobileHeader";

// Sharing is hidden from the header for now; flip this to bring the button back.
const SHARE_BUTTON_VISIBLE = false;
// Deleting lives on the sidebar row menu, so the header menu is hidden too.
const SESSION_MENU_VISIBLE = false;

export type SessionPaneTab = "files" | "docs";

// Tabs for the right-hand pane. A tab is "current" only while the pane is
// open; selecting the current one closes the pane.
export function SessionPaneTabs({ open, tab, onSelect }: { open: boolean; tab: SessionPaneTab; onSelect: (tab: SessionPaneTab) => void }) {
  const t = useT();
  const tabs = [
    { id: "files" as const, label: t("session.tab.files"), icon: FolderTree },
    { id: "docs" as const, label: t("session.tab.docs"), icon: BookOpen },
  ];
  return (
    <div role="tablist" aria-label={t("session.tabs")} className={`hidden lg:flex ${TOOLBAR_GROUP}`}>
      {tabs.map(({ id, label, icon: Icon }) => {
        const active = open && tab === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(id)}
            className={toolbarItemClass(active)}
          >
            <Icon size={16} aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );
}

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
  paneOpen: boolean;
  paneTab: SessionPaneTab;
  selectPaneTab: (tab: SessionPaneTab) => void;
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
  onShare: () => void;
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

// What the session index already knows about a session, which is everything the
// sidebar row renders without a round trip.
export interface IndexedSessionIdentity {
  title?: string | null;
  promptPreview?: string | null;
  projectKey?: string | null;
}

export function sessionHeaderIdentityData(
  loadedMetadataKey: string | null,
  sessionKey: string,
  title: string | null,
  openingMessage: string | null,
  projectKey: string | null,
  indexed: IndexedSessionIdentity | undefined,
): {
  title: string | null;
  openingMessage: string | null;
  projectKey: string | null;
  draft: string;
  metadataLoading: boolean;
} {
  const metadataCurrent = loadedMetadataKey === sessionKey;
  // Name the session from the index rather than waiting for its record: the row
  // the operator just clicked carries the same identity, and the record only
  // corrects it. The skeleton is left for a session nothing has indexed yet.
  const displayTitle = metadataCurrent ? title : indexed?.title ?? null;
  const displayOpeningMessage = metadataCurrent ? openingMessage : indexed?.promptPreview?.trim() || null;
  const displayProjectKey = metadataCurrent ? projectKey : indexed?.projectKey ?? null;
  return {
    title: displayTitle,
    openingMessage: displayOpeningMessage,
    projectKey: displayProjectKey,
    draft: displayTitle ?? "",
    metadataLoading: !displayTitle && !displayOpeningMessage,
  };
}

export function SessionHeaderStats({ turnTotal, usageSummary }: { turnTotal: number; usageSummary: UsageBreakdown | null }) {
  const t = useT();
  if (turnTotal <= 0 && !usageSummary) return null;

  return (
    <div className="flex h-3 min-w-0 items-center gap-1.5 whitespace-nowrap font-mono text-[0.625rem] leading-3 text-ink-faint">
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
    return <ContentHeaderIdentitySkeleton label={t("app.loading")} />;
  }

  return (
    <>
      {projectKey && (
        <ContentHeaderTitle
          to={`/peons/${peonId}/projects/${encodeURIComponent(projectKey)}`}
          title={t("session.project")}
        >
          {titleize(projectKey)}
        </ContentHeaderTitle>
      )}
      <div
        className={`flex min-w-0 flex-1 items-center rounded transition-colors ${editing ? "bg-surface-hover/70" : ""}`}
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
          className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 font-display text-[0.8rem] font-semibold leading-4 text-ink outline-none placeholder:text-ink placeholder:opacity-100 disabled:cursor-wait"
        />
        {editing && (
          <div className="ml-1 flex shrink-0 items-center gap-0.5 pr-0.5">
            <button
              type="button"
              className="grid size-5 place-items-center rounded text-xs text-accent-strong transition-colors hover:bg-accent/15 disabled:opacity-50"
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
              className="grid size-5 place-items-center rounded text-sm text-ink-muted transition-colors hover-wash hover:text-ink disabled:opacity-50"
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
    usageSummary, paneOpen, paneTab, selectPaneTab, confirmDelete, setConfirmDelete,
    deleting, deleteNote, setDeleteNote, stopNote, saveName, cancelRename, remove, viewers, onShare,
  } = props;
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const desktopMenuRef = useRef<HTMLDivElement>(null);
  const [mobileHeaderNode, setMobileHeaderNode] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setMobileHeaderNode(document.getElementById(MOBILE_CONTENT_HEADER_ID));
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

  const renderMenu = (ref: RefObject<HTMLDivElement | null>) => (
    <div className="relative flex-none" ref={ref}>
      <button
        type="button"
        title={t("session.menu")}
        aria-label={t("session.menu")}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((o) => !o)}
        className="flex items-center rounded p-1 text-ink-muted transition-colors hover-wash hover:text-ink"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="12" cy="5" r="1.75" />
          <circle cx="12" cy="12" r="1.75" />
          <circle cx="12" cy="19" r="1.75" />
        </svg>
      </button>
      {menuOpen && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-40 overflow-hidden rounded-lg border border-edge bg-surface py-1 shadow-lg">
          <button
            role="menuitem"
            className="block w-full px-3 py-1.5 text-left font-mono text-xs text-danger transition-colors hover:bg-danger/10"
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
    <ContentHeaderLayout
      compact
      metadataPlacement="below"
      identity={identity}
      metadata={<SessionHeaderStats turnTotal={turnTotal} usageSummary={usageSummary} />}
        actions={(
        <>
          <SessionPresence viewers={viewers} />
          {SHARE_BUTTON_VISIBLE && <button type="button" title="Share session" aria-label="Share session" onClick={onShare} className="grid size-7 place-items-center rounded text-ink-muted transition-colors hover-wash hover:text-ink">
            <Share2 size={15} aria-hidden />
          </button>}
          {SESSION_MENU_VISIBLE && renderMenu(mobileMenuRef)}
        </>
      )}
    />,
    mobileHeaderNode,
  )}

  <ContentHeader
    className="fixed-pane-header-clear hidden md:block"
    metadataPlacement="below"
    identity={identity}
    metadata={<SessionHeaderStats turnTotal={turnTotal} usageSummary={usageSummary} />}
    actions={(
      <>
        <SessionPresence viewers={viewers} />
        <SessionPaneTabs open={paneOpen} tab={paneTab} onSelect={selectPaneTab} />
        {SHARE_BUTTON_VISIBLE && (
        <button
          type="button"
          title="Share session"
          aria-label="Share session"
          onClick={onShare}
          className="hidden size-7 flex-none place-items-center rounded text-ink-muted transition-colors hover-wash hover:text-ink lg:grid"
        >
          <Share2 size={16} aria-hidden />
        </button>
        )}
        {SESSION_MENU_VISIBLE && renderMenu(desktopMenuRef)}
      </>
    )}
    notices={(
      <>
        {confirmDelete && <ConfirmationDialog title={t("session.delete.confirm")} confirmLabel={t("session.delete.confirmYes")} pendingLabel={t("session.delete.deleting")} pending={deleting} onClose={() => setConfirmDelete(false)} onConfirm={() => void remove()} />}
        {renameNote && <div className="font-mono text-xs text-danger">{renameNote}</div>}
        {deleteNote && <div className="font-mono text-xs text-danger">⚠ {deleteNote}</div>}
        {stopNote && <div className="font-mono text-xs text-warning-strong">⚠ {stopNote}</div>}
      </>
    )}
  />
  {(renameNote || deleteNote || stopNote) && (
    <div className="space-y-1 px-3 pt-2 font-mono text-xs md:hidden">
      {renameNote && <div className="text-danger">{renameNote}</div>}
      {deleteNote && <div className="text-danger">⚠ {deleteNote}</div>}
      {stopNote && <div className="text-warning-strong">⚠ {stopNote}</div>}
    </div>
  )}
</>
  );
}
