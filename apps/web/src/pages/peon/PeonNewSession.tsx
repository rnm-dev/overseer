import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router";
import { api, ApiError, json } from "../../api";
import { attachmentUploadPath } from "./fileLinks";
import { useT } from "../../i18n";
import { playPeonSound } from "../../peonSounds";
import { claimAudioFocus } from "../../audioFocus";
import { useNotifications } from "../../notifications";
import { Label } from "../../ui";
import { usePeon } from "./context";
import { Composer, supportsDesktopComposerFocus } from "./Composer";
import { composerDraftKey, useComposerDraft, useComposerDraftFiles } from "./drafts";
import { AgentSelect, defaultEffortIdFor, defaultModelId, effortsForModel, ModelSelect, optionMatches, Picker, ReasoningEffortSelect, providerForAgent, providerForModel, useModels } from "./models";
import { buildNewSessionRequest } from "./newSessionRequest";
import { PathInput } from "./PathInput";

// author: Viktor

interface Project {
  key: string;
  path?: string | null;
  dir?: string | null;
}

// Default upload sandbox — auto-set on a peon that has file transfer off, so
// attaching works without a manual Settings step. Uploads land under here.
const DEFAULT_FILE_ROOT = "/tmp/peon-files";
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const isImage = (f: File) => IMAGE_TYPES.has(f.type);
export function PeonNewSession() {
  const t = useT();
  const { notifyError } = useNotifications();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Preselect this project when opening from within a session (see PeonDetail).
  const preselectProject = searchParams.get("project");
  const { peon, base, wsId, isOwner } = usePeon();
  const { catalog, supported: modelsSupported } = useModels(base);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectKey, setProjectKey] = useState("");
  const [dir, setDir] = useState("");
  const [agent, setAgent] = useState("");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const draftKey = composerDraftKey(wsId, peon.peonId, null);
  const [input, setInput] = useComposerDraft(draftKey);
  const [files, setFiles] = useComposerDraftFiles(draftKey);
  const [filesEnabled, setFilesEnabled] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const selectedProvider = providerForAgent(catalog, agent) ?? (!agent ? (providerForAgent(catalog, catalog?.defaultAgent) ?? providerForModel(catalog, catalog?.defaultModel)) : null);
  const selectedProject = projects.find((project) => project.key === projectKey);
  const selectedProjectRoot = selectedProject?.path ?? selectedProject?.dir;
  const projectBrowseLocations = useMemo(
    () => projects.flatMap((project) => {
      const root = project.path ?? project.dir;
      return root ? [{ root, base: `${base}/projects/${encodeURIComponent(project.key)}/files` }] : [];
    }),
    [base, projects],
  );

  // Preselect the peon's own default agent/model/effort (each provider marks
  // its pick with `default: true` — the top-level defaultModel is often absent)
  // instead of leaving the pickers blank until the operator touches them.
  // defaultAgent (settings.defaultAgent) is the authoritative pick; older
  // peons that omit it fall back to guessing from defaultModel/providers[0].
  useEffect(() => {
    if (!catalog || catalog.providers.length === 0) return;
    const provider =
      providerForAgent(catalog, catalog.defaultAgent) ??
      providerForModel(catalog, catalog.defaultModel) ??
      catalog.providers[0];
    const initialModel = defaultModelId(provider) || "";
    setAgent(provider.agent);
    setModel(initialModel);
    setReasoningEffort(defaultEffortIdFor(effortsForModel(provider, initialModel)) || "");
  }, [catalog]);

  useEffect(() => {
    let alive = true;
    api<{ projects: Project[] }>(`${base}/projects`)
      .then((r) => {
        if (!alive) return;
        const list = r.projects ?? [];
        setProjects(list);
        // Prefer the project passed from the current session, if it's still
        // one the peon offers; otherwise fall back to the first.
        const preselect = preselectProject && list.some((p) => p.key === preselectProject) ? preselectProject : list[0]?.key;
        setProjectKey(preselect ?? "");
        const project = list.find((p) => p.key === preselect);
        setDir(project?.path ?? project?.dir ?? "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [base, preselectProject]);

  // Whether file transfer is enabled on the peon. If it's off, auto-enable a
  // default /tmp sandbox so attaching just works (no manual Settings step).
  useEffect(() => {
    let alive = true;
    api<{ filesEnabled?: boolean }>(`${base}/status`)
      .then(async (s) => {
        if (!alive) return;
        if (s.filesEnabled) return setFilesEnabled(true);
        if (!isOwner) return setFilesEnabled(false);
        try {
          await api(`${base}/settings`, { method: "PATCH", body: JSON.stringify({ fileTransferRoot: DEFAULT_FILE_ROOT }) });
          if (alive) setFilesEnabled(true);
        } catch {
          if (alive) setFilesEnabled(false);
        }
      })
      .catch(() => alive && setFilesEnabled(false));
    return () => {
      alive = false;
    };
  }, [base, isOwner]);

  // Upload one file into a draft sandbox folder (a client-generated id — the
  // session doesn't exist yet) so its path can ride along in the same request
  // that starts the session, exactly like a followup's attachments[].
  async function uploadFile(draftId: string, f: File): Promise<{ path: string; transferId?: string; size?: number; sha256?: string }> {
    const safe = f.name.replace(/[^\w.-]+/g, "_") || "file";
    const buf = await f.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const res = await api<{ path?: string; transferId?: string; size?: number; sha256?: string }>(attachmentUploadPath(base, draftId, safe), {
      method: "PUT",
      body: buf,
      headers: { "content-type": "application/octet-stream", "peon-content-sha256": hex },
    });
    if (!res.path || (res.transferId !== undefined
      && (res.size !== f.size || res.sha256 !== hex))) {
      throw new Error("Overseer returned an invalid committed attachment receipt");
    }
    return {
      path: res.path,
      ...(res.transferId ? { transferId: res.transferId, size: res.size, sha256: res.sha256 } : {}),
    };
  }

  async function start() {
    if ((!input.trim() && files.length === 0) || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const draftId = crypto.randomUUID();
      const attachments: { type: "file" | "image"; path: string; transferId?: string; size?: number; sha256?: string }[] = [];
      for (const f of files) attachments.push({ type: isImage(f) ? "image" : "file", ...await uploadFile(draftId, f) });
      const body = buildNewSessionRequest({ prompt: input, projectKey, dir, agent, model, reasoningEffort, attachments });
      const res = await api<{ id?: string; session?: { id?: string } }>(`${base}/sessions`, {
        ...json(body),
        headers: { "Peon-Request-Id": draftId },
      });
      const id = res.id ?? res.session?.id;
      if (id) {
        // Started from here, so this is the client the operator is using —
        // take the sound from whatever else they left open.
        claimAudioFocus();
        playPeonSound("start");
        setInput("");
        setFiles([]); // the attachments went with the session — don't leave them drafted here
        navigate(`/peons/${peon.peonId}/sessions/${id}`);
      }
      else setSubmitting(false);
    } catch (err) {
      notifyError(err, {
        title: t("newSession.startFailed"),
        fallback: t("error.generic"),
        message: err instanceof ApiError && err.code === "AGENT_UNAVAILABLE" ? t("newSession.agentUnavailable") : undefined,
      });
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="flex min-h-[65vh] flex-col items-center justify-start gap-4 px-0 py-4 sm:justify-center sm:px-6 sm:py-10">
        <h2 className="rune fel-glow text-sm">{t("newSession.title")}</h2>

        <div className="w-full max-w-[76rem]">
          <Composer
            value={input}
            onChange={setInput}
            onSubmit={start}
            placeholder={t("newSession.promptPlaceholder")}
            submitTitle={t("newSession.start")}
            disabled={submitting || !(peon.controlConnected ?? peon.online)}
            pending={submitting}
            autoFocus={supportsDesktopComposerFocus()}
            files={files}
            onFilesChange={setFiles}
            onPreviewFile={setPreview}
            filesEnabled={filesEnabled}
            error={error}
            onErrorChange={setError}
            rightExtra={
              modelsSupported && catalog && catalog.providers.length > 0 ? (
                <>
                  <AgentSelect
                    catalog={catalog}
                    value={agent}
                    onChange={(next) => {
                      if (next === agent) return;
                      setAgent(next);
                      const provider = providerForAgent(catalog, next);
                      const nextModel = defaultModelId(provider) ?? "";
                      setModel(nextModel);
                      setReasoningEffort(defaultEffortIdFor(effortsForModel(provider, nextModel)) ?? "");
                    }}
                    label={t("newSession.agent")}
                    className="model-select-compact"
                  />
                  <ModelSelect
                    provider={selectedProvider}
                    value={model}
                    onChange={(next) => {
                      setModel(next);
                      // Efforts can be per model; land on the new model's own
                      // default rather than carrying one it may not accept.
                      const efforts = effortsForModel(selectedProvider, next);
                      if (!efforts.some((effort) => optionMatches(effort, reasoningEffort))) {
                        setReasoningEffort(defaultEffortIdFor(efforts) ?? "");
                      }
                    }}
                    label={t("newSession.model")}
                    className="model-select-compact"
                    defaultId={defaultModelId(selectedProvider)}
                    allowClear={false}
                  />
                  {effortsForModel(selectedProvider, model).length > 0 && (
                  <ReasoningEffortSelect
                    provider={selectedProvider}
                    model={model}
                    value={reasoningEffort}
                    onChange={setReasoningEffort}
                    label={t("newSession.reasoningEffort")}
                    className="model-select-compact"
                    defaultId={defaultEffortIdFor(effortsForModel(selectedProvider, model))}
                    allowClear={false}
                  />
                  )}
                </>
              ) : undefined
            }
          />
          {projects.length > 0 && (
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label>{t("newSession.project")}</Label>
                <Picker
                  options={projects.map((p) => ({ id: p.key, label: p.key }))}
                  value={projectKey}
                  onChange={(next) => {
                    setProjectKey(next);
                    const project = projects.find((p) => p.key === next);
                    if (project) setDir(project.path ?? project.dir ?? "");
                  }}
                  label={t("newSession.project")}
                  inlineLabel={false}
                  allowClear={false}
                  className="field-picker w-full"
                />
              </div>
              <div className="space-y-1">
                <Label>{t("newProject.dir")}</Label>
                <PathInput
                  base={base}
                  value={dir}
                  onChange={setDir}
                  browseRoot={selectedProjectRoot || undefined}
                  browseBase={projectKey ? `${base}/projects/${encodeURIComponent(projectKey)}/files` : undefined}
                  browseLocations={projectBrowseLocations}
                  className="h-10"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {preview &&
        createPortal(
          <div className="fixed inset-0 z-50 grid cursor-zoom-out place-items-center bg-black/85 p-8" onClick={() => setPreview(null)}>
            <img src={preview} alt="" className="max-h-[90vh] max-w-[90vw] rounded-lg" />
          </div>,
          document.body,
        )}
    </div>
  );
}
