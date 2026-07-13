import { useEffect, useMemo, useState, type InputHTMLAttributes } from "react";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import { api, ApiError } from "../../api";
import { useT } from "../../i18n";
import { Button, Dialog, Input } from "../../ui";

interface DirectoryEntry {
  name: string;
  type?: string;
}

interface DirectoryListing {
  path?: string;
  type?: string;
  entries?: DirectoryEntry[];
}

export interface PathBrowseLocation {
  root: string;
  base: string;
}

type PathInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  base: string;
  value: string;
  onChange: (value: string) => void;
  browseRoot?: string;
  browseBase?: string;
  browseLocations?: PathBrowseLocation[];
};

export function normalizeAbsolutePath(value: string): string {
  const trimmed = value.trim().replace(/\\/g, "/");
  if (!trimmed) return "/";
  const absolute = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const parts: string[] = [];
  for (const segment of absolute.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

export function relativeToRoot(value: string, root: string): string {
  const normalizedRoot = normalizeAbsolutePath(root);
  const normalizedValue = normalizeAbsolutePath(value);
  if (normalizedRoot === "/") return normalizedValue.slice(1);
  if (normalizedValue === normalizedRoot) return "";
  return normalizedValue.startsWith(`${normalizedRoot}/`) ? normalizedValue.slice(normalizedRoot.length + 1) : "";
}

export function pathFromRoot(root: string, relative: string): string {
  const normalizedRoot = normalizeAbsolutePath(root);
  const cleanRelative = relative.split("/").filter(Boolean).join("/");
  if (!cleanRelative) return normalizedRoot;
  return normalizedRoot === "/" ? `/${cleanRelative}` : `${normalizedRoot}/${cleanRelative}`;
}

export function isPathWithin(value: string, root: string): boolean {
  const normalizedRoot = normalizeAbsolutePath(root);
  const normalizedValue = normalizeAbsolutePath(value);
  return normalizedRoot === "/" || normalizedValue === normalizedRoot || normalizedValue.startsWith(`${normalizedRoot}/`);
}

export function virtualDirectoryNames(currentPath: string, locations: PathBrowseLocation[]): string[] {
  const current = normalizeAbsolutePath(currentPath);
  const names = new Set<string>();
  for (const location of locations) {
    const root = normalizeAbsolutePath(location.root);
    if (!isPathWithin(root, current) || root === current) continue;
    const relative = relativeToRoot(root, current);
    const next = relative.split("/").filter(Boolean)[0];
    if (next) names.add(next);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

const encodePath = (value: string) => value.split("/").filter(Boolean).map(encodeURIComponent).join("/");
const isDirectory = (entry: DirectoryEntry) => entry.type === "directory" || entry.type === "dir";

export function PathInput({ base, value, onChange, browseRoot, browseBase, browseLocations, className = "", disabled, ...inputProps }: PathInputProps) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="relative">
        <Input
          {...inputProps}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={`pr-11 ${className}`}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(true)}
          className="absolute bottom-px right-px top-px grid w-10 place-items-center rounded-r-[5px] border-l border-iron-700 text-bone-faint transition-colors hover:bg-iron-900 hover:text-fel-bright disabled:cursor-not-allowed disabled:opacity-40"
          title={t("pathSelector.open")}
          aria-label={t("pathSelector.open")}
        >
          <FolderOpen size={16} aria-hidden />
        </button>
      </div>
      {open && (
        <PathSelectorModal
          base={base}
          initialValue={value}
          browseRoot={browseRoot}
          browseBase={browseBase}
          browseLocations={browseLocations}
          onSelect={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function PathSelectorModal({
  base,
  initialValue,
  browseRoot,
  browseBase,
  browseLocations,
  onSelect,
  onClose,
}: {
  base: string;
  initialValue: string;
  browseRoot?: string;
  browseBase?: string;
  browseLocations?: PathBrowseLocation[];
  onSelect: (value: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [locations, setLocations] = useState<PathBrowseLocation[] | null>(null);
  const [currentPath, setCurrentPath] = useState(() => normalizeAbsolutePath(initialValue || "/"));
  const [entries, setEntries] = useState<DirectoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const explicit = [...(browseLocations ?? []), ...(browseRoot && browseBase ? [{ root: browseRoot, base: browseBase }] : [])];
    if (explicit.length > 0) {
      const unique = new Map(explicit.map((location) => [normalizeAbsolutePath(location.root), { root: normalizeAbsolutePath(location.root), base: location.base }]));
      const nextLocations = [...unique.values()];
      setLocations(nextLocations);
      setCurrentPath(normalizeAbsolutePath(initialValue || nextLocations[0]!.root));
      return () => { alive = false; };
    }
    api<{ fileTransferRoot?: string | null }>(`${base}/settings`)
      .then((settings) => {
        if (!alive) return;
        const nextRoot = normalizeAbsolutePath(settings.fileTransferRoot || "/");
        setLocations([{ root: nextRoot, base: `${base}/files` }]);
        setCurrentPath(normalizeAbsolutePath(initialValue || nextRoot));
      })
      .catch((err) => {
        if (!alive) return;
        setError(err instanceof ApiError ? err.message : t("error.loadFailed"));
      });
    return () => { alive = false; };
  }, [base, browseBase, browseLocations, browseRoot, initialValue, t]);

  useEffect(() => {
    if (locations === null) return;
    let alive = true;
    setEntries(null);
    setError(null);
    const source = locations
      .filter((location) => isPathWithin(currentPath, location.root))
      .sort((a, b) => normalizeAbsolutePath(b.root).length - normalizeAbsolutePath(a.root).length)[0];
    if (!source) {
      setEntries(virtualDirectoryNames(currentPath, locations).map((name) => ({ name, type: "directory" })));
      return () => { alive = false; };
    }
    const relative = relativeToRoot(currentPath, source.root);
    api<DirectoryListing>(`${source.base}/${encodePath(relative)}?stat=1`)
      .then((listing) => {
        if (!alive) return;
        setEntries((listing.entries ?? []).filter(isDirectory).sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch((err) => {
        if (!alive) return;
        setError(err instanceof ApiError ? err.message : t("error.loadFailed"));
        setEntries([]);
      });
    return () => { alive = false; };
  }, [currentPath, locations, t]);

  const crumbs = useMemo(() => currentPath.split("/").filter(Boolean), [currentPath]);
  const selectedPath = locations === null ? "" : currentPath;

  return (
    <Dialog title={t("pathSelector.title")} onClose={onClose} size="lg">
      <div className="overflow-hidden rounded-lg border border-iron-800 bg-iron-950/60">
        <div className="flex min-h-10 flex-wrap items-center gap-1 border-b border-iron-800 px-3 py-2 font-mono text-xs" title={selectedPath || undefined}>
          <button type="button" onClick={() => setCurrentPath("/")} className="text-bone-dim hover:text-fel-bright">/</button>
          {locations === null && <span className="text-bone-dim">{t("app.loading")}</span>}
          {crumbs.map((segment, index) => (
            <span key={`${segment}-${index}`} className="flex min-w-0 items-center gap-1">
              <ChevronRight size={13} className="flex-none text-bone-faint" aria-hidden />
              <button
                type="button"
                onClick={() => setCurrentPath(`/${crumbs.slice(0, index + 1).join("/")}`)}
                className="truncate text-bone-dim hover:text-fel-bright"
              >
                {segment}
              </button>
            </span>
          ))}
        </div>

        <div className="h-72 overflow-y-auto p-1.5">
          {error ? (
            <div className="grid h-full place-items-center px-5 text-center font-mono text-xs text-blood">⚠ {error}</div>
          ) : entries === null ? (
            <div className="grid h-full place-items-center"><div className="forge-spin" /></div>
          ) : entries.length === 0 ? (
            <div className="grid h-full place-items-center font-mono text-xs text-bone-faint">{t("pathSelector.empty")}</div>
          ) : (
            entries.map((entry) => (
              <button
                type="button"
                key={entry.name}
                onClick={() => setCurrentPath(pathFromRoot(currentPath, entry.name))}
                className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left font-mono text-sm text-bone-dim transition-colors hover:bg-fel/[0.07] hover:text-bone"
              >
                <Folder size={16} className="flex-none text-fel-deep" aria-hidden />
                <span className="truncate">{entry.name}</span>
                <ChevronRight size={14} className="ml-auto flex-none text-bone-faint" aria-hidden />
              </button>
            ))
          )}
        </div>
      </div>

      <div className="mt-3 truncate font-mono text-xs text-bone-faint" title={selectedPath}>
        {t("pathSelector.selected")}: <span className="text-bone-dim">{selectedPath || "—"}</span>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="iron" onClick={onClose}>{t("action.cancel")}</Button>
        <Button
          disabled={!selectedPath || !!error}
          onClick={() => {
            onSelect(selectedPath);
            onClose();
          }}
        >
          {t("pathSelector.choose")}
        </Button>
      </div>
    </Dialog>
  );
}
