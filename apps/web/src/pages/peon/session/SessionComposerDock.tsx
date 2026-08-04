import type { Dispatch, SetStateAction } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../../i18n";
import { Composer, supportsDesktopComposerFocus } from "../Composer";
import { ModelSelect, ReasoningEffortSelect, defaultEffortIdFor, effortsForModel, inheritedModelId, type ModelProvider, type ModelsCatalog } from "../models";
import { QueueList } from "./QueueList";
import type { QueueItem } from "./queue";

interface Props {
  setComposerNode: Dispatch<SetStateAction<HTMLDivElement | null>>;
  queueItems: QueueItem[];
  removingQueueItems: ReadonlySet<string>;
  steeringQueueItems: ReadonlySet<string>;
  removeQueuedItem: (id: string) => Promise<void>;
  steerQueuedItem: (id: string) => Promise<void>;
  input: string;
  setInput: (value: string) => void;
  running: boolean;
  enqueue: () => Promise<void>;
  send: () => Promise<void>;
  sending: boolean;
  controlConnected: boolean;
  files: File[];
  setFiles: Dispatch<SetStateAction<File[]>>;
  setAttachmentPreview: Dispatch<SetStateAction<string | null>>;
  filesEnabled: boolean | null;
  sendError: string | null;
  setSendError: Dispatch<SetStateAction<string | null>>;
  modelsSupported: boolean;
  catalog: ModelsCatalog | null;
  sessionKey: string;
  sessionProvider: ModelProvider | null;
  overrideModel: string;
  setOverrideModel: Dispatch<SetStateAction<string>>;
  sessionModel: string | null;
  overrideReasoningEffort: string;
  setOverrideReasoningEffort: Dispatch<SetStateAction<string>>;
  sessionReasoningEffort: string | null;
}

export const SESSION_COMPOSER_DOCK_CLASS = "session-composer fixed bottom-0 left-0 z-40 md:left-[var(--peon-sidebar-width)]";
// The fade belongs to the composer alone: queued messages stack above it on
// their own bubbles, so adding one never drags the shade up the transcript.
export const SESSION_COMPOSER_FADE_CLASS = "theme-transcript-composer-fade pt-4";
const SESSION_COMPOSER_WIDTH_CLASS = "mx-auto max-w-[76rem] px-2 sm:px-6";
export const COMPOSER_FOOTER_PADDING = 100;

// How much transcript tail the dock hides. Queued messages grow the dock, and
// the transcript has to clear all of it; half the viewport is the ceiling, so a
// long queue can never swallow the conversation it belongs to.
export function composerFooterHeight(dockHeight: number, viewportHeight: number): number {
  return Math.max(COMPOSER_FOOTER_PADDING, Math.min(dockHeight, viewportHeight / 2));
}

export function SessionComposerDock(props: Props) {
  const {
    setComposerNode, queueItems, removingQueueItems, steeringQueueItems, removeQueuedItem, steerQueuedItem,
    input, setInput, running, enqueue, send, sending, controlConnected, files, setFiles,
    setAttachmentPreview, filesEnabled, sendError, setSendError,
    modelsSupported, catalog, sessionKey, sessionProvider, overrideModel,
    setOverrideModel, sessionModel, overrideReasoningEffort,
    setOverrideReasoningEffort, sessionReasoningEffort,
  } = props;
  const t = useT();
  // What the composer inherits when the session pinned nothing of its own.
  const inheritedModel = inheritedModelId(catalog, sessionProvider, sessionModel);
  const composerEfforts = effortsForModel(sessionProvider, overrideModel || sessionModel || null);
  const inheritedEffortId = defaultEffortIdFor(composerEfforts);
  return createPortal(
    <div ref={setComposerNode} className={SESSION_COMPOSER_DOCK_CLASS}>
      <div className={SESSION_COMPOSER_WIDTH_CLASS}>
    <QueueList
      items={queueItems}
      removing={removingQueueItems}
      steering={steeringQueueItems}
      onRemove={(id) => void removeQueuedItem(id)}
      onSteer={(id) => void steerQueuedItem(id)}
      t={t}
    />
      </div>
      <div className={SESSION_COMPOSER_FADE_CLASS}>
        <div className={`${SESSION_COMPOSER_WIDTH_CLASS} pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]`}>
    <Composer
      value={input}
      onChange={setInput}
      onSubmit={() => void (running ? enqueue() : send())}
      placeholder={t("session.compose.placeholder")}
      submitTitle={running ? t("session.queue.action") : t("session.compose.send")}
      submitIcon={running ? "queue" : "send"}
      disabled={sending || !controlConnected}
      pending={sending}
      autoFocus={supportsDesktopComposerFocus()}
      files={files}
      onFilesChange={setFiles}
      onPreviewFile={setAttachmentPreview}
      filesEnabled={filesEnabled}
      error={sendError}
      onErrorChange={setSendError}
      rightExtra={
        modelsSupported && catalog && catalog.providers.length > 0 ? (
          <>
            <ModelSelect
              key={`model:${sessionKey}`}
              provider={sessionProvider}
              value={overrideModel}
              onChange={setOverrideModel}
              label={t("session.compose.model")}
              className="model-select-compact"
              defaultLabel={t("model.default")}
              // No override means the session's own model, or — when it pinned
              // nothing — whatever the peon would pick for it.
              defaultId={sessionModel ?? inheritedModel ?? undefined}
            />
            {composerEfforts.length > 0 && (
            <ReasoningEffortSelect
              key={`effort:${sessionKey}`}
              provider={sessionProvider}
              model={overrideModel || sessionModel || null}
              value={overrideReasoningEffort}
              onChange={setOverrideReasoningEffort}
              label={t("session.compose.reasoningEffort")}
              className="model-select-compact"
              defaultLabel={t("model.default")}
              defaultId={sessionReasoningEffort ?? inheritedEffortId}
            />
            )}
          </>
        ) : undefined
      }
    />
        </div>
      </div>
    </div>,
    document.body,
  );
}
