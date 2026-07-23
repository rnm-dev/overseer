import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { HighlightedCode, Markdown, languageForPath } from "../../components/RichText";
import { useT } from "../../i18n";
import { Card } from "../../ui";
import { usePeon } from "./context";
import { encodeProjectPath, formatFileSize, ProjectFileTree } from "./ProjectFiles";
import { ProjectTabs } from "./ProjectTabs";
import { ProjectPageHeader } from "./ProjectPageHeader";

interface Viewer {
  path: string;
  loading?: boolean;
  text?: string;
  image?: string;
  note?: string;
}

const MAX_VIEW_BYTES = 1_000_000;
const TEXT_CAP = 400_000;
const isImageName = (name: string) => /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(name);

export function ProjectFileBrowser() {
  const t = useT();
  const { key = "" } = useParams();
  const { peon, base } = usePeon();
  const filesBase = `${base}/projects/${encodeURIComponent(key)}/files`;
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const imgUrlRef = useRef<string | null>(null);

  const revokeImage = () => {
    if (imgUrlRef.current) URL.revokeObjectURL(imgUrlRef.current);
    imgUrlRef.current = null;
  };
  useEffect(() => revokeImage, []);

  const openFile = useCallback(async (filePath: string, size?: number) => {
    revokeImage();
    const image = isImageName(filePath);
    if (!image && typeof size === "number" && size > MAX_VIEW_BYTES) {
      setViewer({ path: filePath, note: t("proj.files.tooLarge", { size: formatFileSize(size) }) });
      return;
    }
    setViewer({ path: filePath, loading: true });
    try {
      const response = await fetch(`/api${filesBase}/${encodeProjectPath(filePath)}`, { credentials: "same-origin" });
      if (!response.ok) {
        setViewer({ path: filePath, note: response.status === 404 || response.status === 401 ? t("peon.unsupported") : t("error.loadFailed") });
        return;
      }
      const contentType = response.headers.get("content-type") || "";
      if (contentType.startsWith("image/") || image) {
        const url = URL.createObjectURL(await response.blob());
        imgUrlRef.current = url;
        setViewer({ path: filePath, image: url });
      } else {
        const raw = await response.text();
        setViewer({ path: filePath, text: raw.length > TEXT_CAP ? `${raw.slice(0, TEXT_CAP)}\n\n…truncated…` : raw });
      }
    } catch {
      setViewer({ path: filePath, note: t("error.loadFailed") });
    }
  }, [filesBase, t]);

  if (!peon.online) return <p className="font-mono text-sm text-bone-faint">{t("peon.offlineNote")}</p>;

  return (
    <div className="space-y-3">
      <ProjectPageHeader />
      <ProjectTabs />
      <div className="grid gap-4 lg:grid-cols-[19rem_minmax(0,1fr)]">
        <Card className="flex max-h-[calc(100vh-10rem)] min-h-[28rem] flex-col overflow-hidden">
          <div className="border-b border-iron-800 px-3 py-2.5 font-display text-xs font-semibold text-bone-dim">{t("session.files.title")}</div>
          <ProjectFileTree filesBase={filesBase} activePath={viewer?.path} onOpenFile={openFile} className="flex-1" />
        </Card>
        <Card className="flex max-h-[calc(100vh-10rem)] min-h-[28rem] flex-col overflow-hidden">
          {!viewer ? <p className="grid flex-1 place-items-center p-6 text-center font-mono text-sm text-bone-faint">{t("proj.files.pick")}</p> : <>
            <div className="truncate border-b border-iron-800 px-4 py-2.5 font-mono text-xs text-bone-dim">{viewer.path}</div>
            <div className="min-h-0 flex-1 overflow-auto">
              {viewer.loading ? <div className="p-4"><div className="forge-spin" /></div>
                : viewer.note ? <p className="p-4 font-mono text-xs text-bone-faint">{viewer.note}</p>
                  : viewer.image ? <div className="grid min-h-full place-items-center bg-iron-950/35 p-5"><img src={viewer.image} alt="" className="max-h-full max-w-full rounded" /></div>
                    : languageForPath(viewer.path) === "markdown" ? <article className="mx-auto max-w-4xl p-6 text-sm leading-relaxed text-bone"><Markdown source={viewer.text ?? ""} /></article>
                      : <HighlightedCode source={viewer.text ?? ""} language={languageForPath(viewer.path)} className="min-h-full rounded-none border-0" />}
            </div>
          </>}
        </Card>
      </div>
    </div>
  );
}
