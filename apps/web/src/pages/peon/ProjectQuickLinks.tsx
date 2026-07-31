import { useEffect, useState, type FormEvent } from "react";
import { ExternalLink, Plus, Save, Trash2 } from "lucide-react";
import { ApiError } from "../../api";
import { useT } from "../../i18n";
import { Card, Input } from "../../ui";
import {
  createProjectQuickLink,
  deleteProjectQuickLink,
  updateProjectQuickLink,
  type ProjectQuickLink,
} from "./peonApi";

export function orderedQuickLinks(links: ProjectQuickLink[]): ProjectQuickLink[] {
  return [...links].sort((left, right) => left.order - right.order);
}

export function ProjectQuickLinksList({ links, empty = true }: { links: ProjectQuickLink[]; empty?: boolean }) {
  const t = useT();
  const ordered = orderedQuickLinks(links);
  if (ordered.length === 0) return empty ? <p className="text-xs text-ink-faint">{t("proj.quickLinks.empty")}</p> : null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {ordered.map((link) => (
        <li key={link.id} className="min-w-0">
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="group inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-edge bg-surface/35 px-2.5 text-xs text-ink-muted transition-colors hover:border-accent/35 hover:bg-accent/[0.07] hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
          >
            <span className="min-w-0 truncate">{link.title}</span>
            <ExternalLink size={11} className="flex-none text-ink-faint transition-colors group-hover:text-accent-strong" aria-hidden />
          </a>
        </li>
      ))}
    </ul>
  );
}

export function ProjectQuickLinksCard({ links, cached = false }: { links: ProjectQuickLink[]; cached?: boolean }) {
  const t = useT();
  return (
    <Card className="px-3.5 py-3">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="font-display text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-ink-muted">{t("proj.quickLinks")}</h2>
        {links.length > 0 && <span className="rounded bg-surface-hover px-1.5 py-0.5 font-mono text-[0.6rem] text-ink-faint">{links.length}</span>}
      </div>
      <div>
        {cached && <p className="mb-2 font-mono text-[0.65rem] text-warning/80">{t("proj.quickLinks.cached")}</p>}
        <ProjectQuickLinksList links={links} />
      </div>
    </Card>
  );
}

interface DraftLink extends ProjectQuickLink {
  draftTitle: string;
  draftUrl: string;
}

function draftsOf(links: ProjectQuickLink[]): DraftLink[] {
  return orderedQuickLinks(links).map((link) => ({ ...link, draftTitle: link.title, draftUrl: link.url }));
}

export function ProjectQuickLinksEditor({
  base,
  projectKey,
  online,
  links,
}: {
  base: string;
  projectKey: string;
  online: boolean;
  links: ProjectQuickLink[];
}) {
  const t = useT();
  const [drafts, setDrafts] = useState(() => draftsOf(links));
  const [newTitle, setNewTitle] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDrafts(draftsOf(links)), [links]);

  const message = (cause: unknown) => cause instanceof ApiError ? cause.message : t("error.generic");

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!online || busy || !newTitle.trim() || !newUrl.trim()) return;
    setBusy("new");
    setError(null);
    try {
      const created = await createProjectQuickLink(base, projectKey, { title: newTitle.trim(), url: newUrl.trim() });
      setDrafts((current) => draftsOf([...current, created]));
      setNewTitle("");
      setNewUrl("");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(null);
    }
  }

  async function save(link: DraftLink) {
    if (!online || busy || !link.draftTitle.trim() || !link.draftUrl.trim()) return;
    setBusy(link.id);
    setError(null);
    try {
      const updated = await updateProjectQuickLink(base, projectKey, link.id, {
        title: link.draftTitle.trim(),
        url: link.draftUrl.trim(),
      });
      setDrafts((current) => draftsOf(current.map((item) => item.id === link.id ? updated : item)));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(null);
    }
  }

  async function remove(link: DraftLink) {
    if (!online || busy) return;
    setBusy(link.id);
    setError(null);
    try {
      await deleteProjectQuickLink(base, projectKey, link.id);
      setDrafts((current) => current.filter((item) => item.id !== link.id));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(null);
    }
  }

  const change = (id: string, patch: Partial<Pick<DraftLink, "draftTitle" | "draftUrl">>) => {
    setDrafts((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3 border-b border-edge bg-surface-raised/40 px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-xs font-bold text-ink">{t("proj.quickLinks")}</h2>
          <p className="mt-0.5 truncate text-[0.68rem] text-ink-faint">{t("proj.quickLinks.hint")}</p>
        </div>
        <span className="rounded bg-surface-hover px-1.5 py-0.5 font-mono text-[0.62rem] text-ink-faint">{drafts.length}/100</span>
      </div>
      <div className="space-y-2.5 p-3">
        {drafts.length === 0 && <p className="px-1 py-1 text-xs text-ink-faint">{t("proj.quickLinks.empty")}</p>}
        {drafts.length > 0 && (
          <div className="divide-y divide-iron-800 overflow-hidden rounded-lg border border-edge">
            {drafts.map((link) => {
              const dirty = link.draftTitle.trim() !== link.title || link.draftUrl.trim() !== link.url;
              return (
                <div key={link.id} className="grid gap-1.5 bg-surface/20 p-2 md:grid-cols-[minmax(8rem,1fr)_minmax(12rem,2fr)_auto] md:items-center">
                  <label className="sr-only" htmlFor={`quick-link-title-${link.id}`}>{t("proj.quickLinks.title")}</label>
                  <Input id={`quick-link-title-${link.id}`} className="h-8 px-2.5 text-xs" maxLength={120} value={link.draftTitle} disabled={!online || busy !== null} onChange={(event) => change(link.id, { draftTitle: event.target.value })} />
                  <label className="sr-only" htmlFor={`quick-link-url-${link.id}`}>{t("proj.quickLinks.url")}</label>
                  <Input id={`quick-link-url-${link.id}`} className="h-8 px-2.5 font-mono text-[0.68rem]" type="url" maxLength={2048} value={link.draftUrl} disabled={!online || busy !== null} onChange={(event) => change(link.id, { draftUrl: event.target.value })} />
                  <div className="flex justify-end gap-1">
                    <button type="button" className="grid h-8 w-8 place-items-center rounded-md text-ink-faint transition-colors hover:bg-accent/10 hover:text-accent-strong disabled:opacity-30" aria-label={t("proj.quickLinks.save")} disabled={!online || busy !== null || !dirty || !link.draftTitle.trim() || !link.draftUrl.trim()} onClick={() => void save(link)}>
                      <Save size={13} aria-hidden />
                    </button>
                    <button type="button" className="grid h-8 w-8 place-items-center rounded-md text-ink-faint transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-30" aria-label={t("proj.quickLinks.delete")} disabled={!online || busy !== null} onClick={() => void remove(link)}>
                      <Trash2 size={13} aria-hidden />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <form className="grid gap-1.5 rounded-lg border border-dashed border-edge-strong bg-surface/15 p-2 md:grid-cols-[minmax(8rem,1fr)_minmax(12rem,2fr)_auto] md:items-center" onSubmit={add}>
          <label className="sr-only" htmlFor="new-quick-link-title">{t("proj.quickLinks.title")}</label>
          <Input id="new-quick-link-title" className="h-8 px-2.5 text-xs" maxLength={120} value={newTitle} disabled={!online || busy !== null} onChange={(event) => setNewTitle(event.target.value)} placeholder={t("proj.quickLinks.titlePlaceholder")} />
          <label className="sr-only" htmlFor="new-quick-link-url">{t("proj.quickLinks.url")}</label>
          <Input id="new-quick-link-url" className="h-8 px-2.5 font-mono text-[0.68rem]" type="url" maxLength={2048} value={newUrl} disabled={!online || busy !== null} onChange={(event) => setNewUrl(event.target.value)} placeholder="https://…" />
          <button type="submit" className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-accent/35 bg-accent/10 px-3 font-display text-[0.68rem] font-semibold text-accent-strong transition-colors hover:bg-accent/15 disabled:opacity-40" disabled={!online || busy !== null || !newTitle.trim() || !newUrl.trim()}>
            <Plus size={12} aria-hidden /> {t("proj.quickLinks.add")}
          </button>
        </form>
        {error && <p role="alert" className="px-1 font-mono text-xs text-danger">⚠ {error}</p>}
      </div>
    </Card>
  );
}
