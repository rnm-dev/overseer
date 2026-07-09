import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, getToken } from "../../api";
import { Button, Card } from "../../ui";
import { useT } from "../../i18n";
import { usePeon } from "./context";

// author: Viktor

interface Detail {
  key?: string;
  label?: string;
  scope?: string;
  dir?: string;
  info?: string;
  isSetUp?: boolean;
  integrationLabel?: string | null;
}
interface Entry {
  name: string;
  type?: string; // "dir" | "file"
  size?: number;
}
interface Viewer {
  path: string;
  loading?: boolean;
  text?: string;
  image?: string;
  note?: string;
}

const MAX_VIEW_BYTES = 1_000_000;
const TEXT_CAP = 400_000;
const encPath = (p: string) => p.split("/").filter(Boolean).map(encodeURIComponent).join("/");
const fmtSize = (n?: number) => (typeof n !== "number" ? "" : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const isImageName = (n: string) => /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(n);

export function PeonProjectDetail() {
  const t = useT();
  const navigate = useNavigate();
  const { peon, base } = usePeon();
  const { key = "", peonId = "" } = useParams();
  const filesBase = `${base}/projects/${encodeURIComponent(key)}/files`;
  const [acting, setActing] = useState<"setup" | "verify" | null>(null);
  const [actErr, setActErr] = useState<string | null>(null);

  // Setup/verify each spawn a session — route to its live tail on success.
  async function runLifecycle(kind: "setup" | "verify") {
    if (acting) return;
    setActing(kind);
    setActErr(null);
    try {
      const res = await api<{ id?: string; session?: { id?: string } }>(`${base}/projects/${encodeURIComponent(key)}/${kind}`, { method: "POST" });
      const id = res.id ?? res.session?.id;
      if (id) navigate(`/peons/${peonId}/sessions/${id}`);
      else setActing(null);
    } catch (err) {
      setActErr(err instanceof ApiError && err.status === 400 ? t("proj.setupFirst") : err instanceof ApiError ? err.message : t("error.loadFailed"));
      setActing(null);
    }
  }

  const [detail, setDetail] = useState<Detail | null>(null);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [browseErr, setBrowseErr] = useState<"unsupported" | "error" | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const imgUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<Detail>(`${base}/projects/${encodeURIComponent(key)}`)
      .then((d) => alive && setDetail(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [base, key]);

  // Directory listing for the current path.
  useEffect(() => {
    if (!peon.online) return;
    let alive = true;
    setEntries(null);
    setBrowseErr(null);
    api<{ entries?: Entry[] }>(`${filesBase}/${encPath(path)}?stat=1`)
      .then((r) => alive && setEntries(r.entries ?? []))
      .catch((err) => {
        if (!alive) return;
        // 404/401 ⇒ the peon predates the project-files endpoint (or gates it elsewhere).
        setBrowseErr(err instanceof ApiError && (err.status === 404 || err.status === 401) ? "unsupported" : "error");
      });
    return () => {
      alive = false;
    };
  }, [filesBase, path, peon.online]);

  const revokeImg = () => {
    if (imgUrlRef.current) URL.revokeObjectURL(imgUrlRef.current);
    imgUrlRef.current = null;
  };
  useEffect(() => revokeImg, []);

  const openFile = useCallback(
    async (filePath: string, size?: number) => {
      revokeImg();
      const image = isImageName(filePath);
      if (!image && typeof size === "number" && size > MAX_VIEW_BYTES) {
        setViewer({ path: filePath, note: t("proj.files.tooLarge", { size: fmtSize(size) }) });
        return;
      }
      setViewer({ path: filePath, loading: true });
      try {
        const token = getToken();
        const res = await fetch(`/api${filesBase}/${encPath(filePath)}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
        if (!res.ok) {
          setViewer({ path: filePath, note: res.status === 404 || res.status === 401 ? t("peon.unsupported") : t("error.loadFailed") });
          return;
        }
        const ct = res.headers.get("content-type") || "";
        if (ct.startsWith("image/") || image) {
          const url = URL.createObjectURL(await res.blob());
          imgUrlRef.current = url;
          setViewer({ path: filePath, image: url });
        } else {
          const raw = await res.text();
          setViewer({ path: filePath, text: raw.length > TEXT_CAP ? raw.slice(0, TEXT_CAP) + "\n\n…truncated…" : raw });
        }
      } catch {
        setViewer({ path: filePath, note: t("error.loadFailed") });
      }
    },
    [filesBase, t],
  );

  if (!peon.online) return <p className="font-mono text-sm text-bone-faint">{t("peon.offlineNote")}</p>;

  const crumbs = path.split("/").filter(Boolean);
  const sorted = [...(entries ?? [])].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));

  return (
    <div className="space-y-5">
      <Link to=".." relative="path" className="font-mono text-xs text-bone-dim hover:text-fel-bright">
        {t("proj.back")}
      </Link>

      {/* detail card */}
      <div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-display text-2xl font-extrabold tracking-wide text-bone">{detail?.label || key}</h1>
          <span className="font-mono text-xs text-bone-faint">{key}</span>
          {detail?.scope && <span className="rounded bg-iron-800 px-1.5 py-0.5 font-mono text-[0.7rem] text-bone-dim">{detail.scope}</span>}
        </div>
        {detail?.dir && <div className="mt-1 truncate font-mono text-xs text-bone-dim">{detail.dir}</div>}
        {detail?.info && <p className="mt-2 max-w-3xl whitespace-pre-wrap text-sm text-bone-dim">{detail.info}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => runLifecycle("setup")} disabled={!!acting}>
            {acting === "setup" ? t("proj.settingUp") : detail?.isSetUp ? t("proj.reSetup") : t("proj.setup")}
          </Button>
          <Button size="sm" variant="iron" onClick={() => runLifecycle("verify")} disabled={!!acting || !detail?.isSetUp} title={detail?.isSetUp ? undefined : t("proj.setupFirst")}>
            {acting === "verify" ? t("proj.verifying") : t("proj.verify")}
          </Button>
          {actErr && <span className="font-mono text-xs text-blood">⚠ {actErr}</span>}
        </div>
      </div>

      {/* browser + viewer */}
      <div className="grid gap-4 lg:grid-cols-[19rem_minmax(0,1fr)]">
        <Card className="flex max-h-[70vh] flex-col overflow-hidden">
          {/* breadcrumb */}
          <div className="flex flex-wrap items-center gap-1 border-b border-iron-800 px-3 py-2 font-mono text-xs text-bone-dim">
            <button className="hover:text-fel-bright" onClick={() => setPath("")}>
              {t("proj.files.root")}
            </button>
            {crumbs.map((seg, i) => (
              <span key={i} className="flex items-center gap-1">
                <span className="text-bone-faint">/</span>
                <button className="truncate hover:text-fel-bright" onClick={() => setPath(crumbs.slice(0, i + 1).join("/"))}>
                  {seg}
                </button>
              </span>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {browseErr === "unsupported" ? (
              <p className="p-4 font-mono text-xs text-bone-faint">{t("peon.unsupported")}</p>
            ) : browseErr === "error" ? (
              <p className="p-4 font-mono text-xs text-blood">⚠ {t("error.loadFailed")}</p>
            ) : entries === null ? (
              <div className="p-4">
                <div className="forge-spin" />
              </div>
            ) : sorted.length === 0 ? (
              <p className="p-4 font-mono text-xs text-bone-faint">{t("proj.files.empty")}</p>
            ) : (
              <ul className="py-1">
                {sorted.map((e) => {
                  const full = path ? `${path}/${e.name}` : e.name;
                  const dir = e.type === "dir";
                  const active = viewer?.path === full;
                  return (
                    <li key={e.name}>
                      <button
                        onClick={() => (dir ? setPath(full) : openFile(full, e.size))}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs transition-colors hover:bg-fel/[0.04] ${active ? "text-fel-bright" : "text-bone-dim"}`}
                      >
                        <span className={`flex-none ${dir ? "text-fel-deep" : "text-bone-faint"}`}>
                          {dir ? (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                            </svg>
                          ) : (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
                              <path d="M14 2v6h6" />
                            </svg>
                          )}
                        </span>
                        <span className="flex-1 truncate">{e.name}</span>
                        {!dir && e.size !== undefined && <span className="flex-none text-[0.65rem] text-bone-faint">{fmtSize(e.size)}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Card>

        {/* viewer */}
        <Card className="flex max-h-[70vh] min-h-[16rem] flex-col overflow-hidden">
          {!viewer ? (
            <p className="grid flex-1 place-items-center p-6 text-center font-mono text-sm text-bone-faint">{t("proj.files.pick")}</p>
          ) : (
            <>
              <div className="truncate border-b border-iron-800 px-4 py-2 font-mono text-xs text-bone-dim">{viewer.path}</div>
              <div className="min-h-0 flex-1 overflow-auto">
                {viewer.loading ? (
                  <div className="p-4">
                    <div className="forge-spin" />
                  </div>
                ) : viewer.note ? (
                  <p className="p-4 font-mono text-xs text-bone-faint">{viewer.note}</p>
                ) : viewer.image ? (
                  <div className="p-4">
                    <img src={viewer.image} alt="" className="max-w-full rounded" />
                  </div>
                ) : (
                  <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-bone-dim">{viewer.text}</pre>
                )}
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
