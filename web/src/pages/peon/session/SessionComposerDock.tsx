import type { Dispatch, SetStateAction } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../../i18n";
import { Composer, supportsDesktopComposerFocus } from "../Composer";
import { ModelSelect, ReasoningEffortSelect, modelLabel, type ModelProvider, type ModelsCatalog } from "../models";
import { QueueList } from "./QueueList";
import type { QueueItem } from "./queue";

interface Props {
  setComposerNode: Dispatch<SetStateAction<HTMLDivElement | null>>;
  queueItems: QueueItem[];
  removingQueueItems: ReadonlySet<string>;
  sendingQueueItems: ReadonlySet<string>;
  removeQueuedItem: (id: string) => Promise<void>;
  sendQueuedItemNow: (id: string) => Promise<void>;
  input: string;
  setInput: (value: string) => void;
  running: boolean;
  enqueue: (startNow: boolean) => Promise<void>;
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

export function SessionComposerDock(props: Props) {
  const {
    setComposerNode, queueItems, removingQueueItems, sendingQueueItems, removeQueuedItem, sendQueuedItemNow,
    input, setInput, running, enqueue, send, sending, controlConnected, files, setFiles,
    setAttachmentPreview, filesEnabled, sendError, setSendError,
    modelsSupported, catalog, sessionKey, sessionProvider, overrideModel,
    setOverrideModel, sessionModel, overrideReasoningEffort,
    setOverrideReasoningEffort, sessionReasoningEffort,
  } = props;
  const t = useT();
  return createPortal(
    <div ref={setComposerNode} className="session-composer fixed bottom-0 left-0 right-0 z-40 bg-gradient-to-t from-void via-void to-transparent pt-6 md:left-[var(--peon-sidebar-width)]">
      <div className="mx-auto max-w-[76rem] px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-[max(1rem,env(safe-area-inset-bottom))]">
    <QueueList
      items={queueItems}
      removing={removingQueueItems}
      sending={sendingQueueItems}
      onRemove={(id) => void removeQueuedItem(id)}
      onSendNow={(id) => void sendQueuedItemNow(id)}
      t={t}
    />
    <Composer
      value={input}
      onChange={setInput}
      onSubmit={() => void (running ? enqueue(false) : send())}
      placeholder={t("session.compose.placeholder")}
      submitTitle={running ? t("session.queue.action") : t("session.compose.send")}
      submitLabel={running ? t("session.queue.action") : undefined}
      disabled={sending || !controlConnected}
      pending={sending}
      autoFocus={supportsDesktopComposerFocus()}
      files={files}
      onFilesChange={setFiles}
      onPreviewFile={setAttachmentPreview}
      filesEnabled={filesEnabled}
      error={sendError}
      onErrorChange={setSendError}
      secondaryAction={running ? {
        label: t("session.queue.stop"),
        onClick: () => void enqueue(true),
        disabled: sending || (!input.trim() && files.length === 0),
        pending: sending,
      } : undefined}
      rightExtra={
        modelsSupported && catalog && catalog.providers.length > 0 ? (
          <>
            <ModelSelect
              key={`model:${sessionKey}`}
              provider={sessionProvider}
              value={overrideModel || sessionModel || ""}
              onChange={setOverrideModel}
              label={t("session.compose.model")}
              className="model-select-compact"
              defaultLabel={sessionModel ? modelLabel(catalog, sessionModel) ?? sessionModel : t("model.default")}
              defaultId={sessionModel ?? undefined}
              allowClear={!sessionModel}
            />
            <ReasoningEffortSelect
              key={`effort:${sessionKey}`}
              provider={sessionProvider}
              value={overrideReasoningEffort}
              onChange={setOverrideReasoningEffort}
              label={t("session.compose.reasoningEffort")}
              className="model-select-compact"
              defaultLabel={sessionReasoningEffort ? sessionProvider?.reasoningEfforts.find((effort) => effort.id === sessionReasoningEffort)?.label ?? sessionReasoningEffort : t("model.default")}
            />
          </>
        ) : undefined
      }
    />
      </div>
    </div>,
    document.body,
  );
}
