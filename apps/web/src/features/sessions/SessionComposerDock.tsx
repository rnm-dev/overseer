import { useEffect, useState, type Dispatch, type KeyboardEvent, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../shared/i18n";
import { Composer, supportsDesktopComposerFocus } from "./Composer";
import { ModelSelect, ReasoningEffortSelect, defaultEffortIdFor, effectiveModelId, inheritedModelId, isReasoningEffortValid, reasoningEffortsForEffectiveModel, type ModelProvider, type ModelsCatalog } from "../settings/models";
import { QueueList } from "./QueueList";
import type { QueueItem } from "./queue";
import type { MessageAttachment } from "./parsing";
import type { SelectedTextReply } from "./selectedTextReply";
import { mentionForAtomicDeletion, type ComposerMention, type MentionPrincipal } from "./contextMentions";

interface Props {
  setComposerNode: Dispatch<SetStateAction<HTMLDivElement | null>>;
  queueItems: QueueItem[];
  removingQueueItems: ReadonlySet<string>;
  steeringQueueItems: ReadonlySet<string>;
  removeQueuedItem: (id: string) => Promise<void>;
  editQueuedItem: (id: string) => Promise<void>;
  steerQueuedItem: (id: string) => Promise<void>;
  input: string;
  setInput: (value: string, caret?: number) => void;
  running: boolean;
  enqueue: () => Promise<void>;
  send: () => Promise<void>;
  sendContext: () => Promise<void>;
  sending: boolean;
  controlConnected: boolean;
  files: File[];
  setFiles: Dispatch<SetStateAction<File[]>>;
  carried: MessageAttachment[];
  setCarried: (carried: MessageAttachment[]) => void;
  setAttachmentPreview: Dispatch<SetStateAction<string | null>>;
  filesEnabled: boolean | null;
  sendError: string | null;
  setSendError: Dispatch<SetStateAction<string | null>>;
  replyTo: SelectedTextReply | null;
  setReplyTo: Dispatch<SetStateAction<SelectedTextReply | null>>;
  onOpenReplySource?: (replyTo: SelectedTextReply) => void;
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
  sendToPeople: boolean;
  mentionSuggestions: MentionPrincipal[];
  onSelectMention: (principal: MentionPrincipal) => void;
  mentionMenuOpen: boolean;
  selectedMentions: ComposerMention[];
  onRemoveMention: (mention: ComposerMention) => void;
  caretRequest: { position: number; seq: number } | null;
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
    setComposerNode, queueItems, removingQueueItems, steeringQueueItems, removeQueuedItem, editQueuedItem, steerQueuedItem,
    input, setInput, running, enqueue, send, sendContext, sending, controlConnected, files, setFiles,
    carried, setCarried, setAttachmentPreview, filesEnabled, sendError, setSendError,
    replyTo, setReplyTo, onOpenReplySource,
    modelsSupported, catalog, sessionKey, sessionProvider, overrideModel,
    setOverrideModel, sessionModel, overrideReasoningEffort,
    setOverrideReasoningEffort, sessionReasoningEffort,
    sendToPeople, mentionSuggestions, onSelectMention, mentionMenuOpen,
    selectedMentions, onRemoveMention, caretRequest,
  } = props;
  const t = useT();
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [dismissedMentionInput, setDismissedMentionInput] = useState<string | null>(null);
  const mentionPickerOpen = mentionMenuOpen && mentionSuggestions.length > 0 && dismissedMentionInput !== input;
  const mentionOptionCount = mentionSuggestions.length;
  const mentionListboxId = "session-composer-mention-listbox";
  useEffect(() => {
    setActiveMentionIndex(0);
    setDismissedMentionInput(null);
  }, [input]);
  useEffect(() => setActiveMentionIndex((current) => Math.min(current, mentionOptionCount - 1)), [mentionOptionCount]);
  const chooseMentionOption = (index: number) => onSelectMention(mentionSuggestions[index]!);
  const handleMentionKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.key === "Backspace" || event.key === "Delete") {
      const target = mentionForAtomicDeletion(input, selectedMentions, event.currentTarget.selectionStart, event.currentTarget.selectionEnd, event.key);
      if (target) {
        event.preventDefault();
        onRemoveMention(target);
        return true;
      }
    }
    if (!mentionPickerOpen) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveMentionIndex((current) => (current + direction + mentionOptionCount) % mentionOptionCount);
      return true;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActiveMentionIndex(event.key === "Home" ? 0 : mentionOptionCount - 1);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      chooseMentionOption(activeMentionIndex);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissedMentionInput(input);
      return true;
    }
    return false;
  };
  // What the composer inherits when the session pinned nothing of its own.
  const inheritedModel = inheritedModelId(catalog, sessionProvider, sessionModel);
  const effectiveModel = effectiveModelId(catalog, sessionProvider, overrideModel, sessionModel);
  const composerEfforts = reasoningEffortsForEffectiveModel(sessionProvider, effectiveModel);
  const inheritedEffortId = sessionReasoningEffort && isReasoningEffortValid(sessionProvider, effectiveModel, sessionReasoningEffort)
    ? sessionReasoningEffort
    : defaultEffortIdFor(composerEfforts);
  const selectModel = (next: string) => {
    const nextEffectiveModel = effectiveModelId(catalog, sessionProvider, next, sessionModel);
    setOverrideModel(next);
    setOverrideReasoningEffort((current) => isReasoningEffortValid(sessionProvider, nextEffectiveModel, current) ? current : "");
  };
  return createPortal(
    <div ref={setComposerNode} className={SESSION_COMPOSER_DOCK_CLASS}>
      <div className={SESSION_COMPOSER_WIDTH_CLASS}>
    <QueueList
      items={queueItems}
      removing={removingQueueItems}
      steering={steeringQueueItems}
      onRemove={(id) => void removeQueuedItem(id)}
      onEdit={(id) => void editQueuedItem(id)}
      onSteer={(id) => void steerQueuedItem(id)}
      t={t}
    />
      </div>
      <div className={SESSION_COMPOSER_FADE_CLASS}>
        <div className={`${SESSION_COMPOSER_WIDTH_CLASS} pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]`}>
    <div className="relative">
      {mentionPickerOpen && (
        <div id={mentionListboxId} className="mention-picker absolute bottom-[calc(100%+0.5rem)] left-0 z-50 w-72 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-edge-strong bg-surface-raised py-1 shadow-xl" role="listbox" aria-label={t("session.compose.mentionPicker")}>
          {mentionSuggestions.map((principal, index) => <button id={`${mentionListboxId}-${index}`} key={`${principal.kind}:${principal.id}`} type="button" role="option" aria-selected={activeMentionIndex === index} className={`block w-full truncate px-3 py-2 text-left font-body text-sm ${activeMentionIndex === index ? "bg-accent/15 text-accent-strong" : "text-ink hover:bg-surface-hover"}`} onMouseEnter={() => setActiveMentionIndex(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => onSelectMention(principal)}>@{principal.label}</button>)}
        </div>
      )}
    <Composer
      value={input}
      onChange={setInput}
      onSubmit={() => void (sendToPeople ? sendContext() : running ? enqueue() : send())}
      placeholder={t("session.compose.placeholder")}
      submitTitle={sendToPeople ? t("session.compose.sendToPeople") : running ? t("session.queue.action") : t("session.compose.send")}
      submitIcon={!sendToPeople && running ? "queue" : "send"}
      disabled={sending || !controlConnected}
      pending={sending}
      autoFocus={supportsDesktopComposerFocus()}
      files={files}
      onFilesChange={setFiles}
      carried={carried}
      onCarriedChange={setCarried}
      onPreviewFile={setAttachmentPreview}
      filesEnabled={filesEnabled}
      error={sendError}
      onErrorChange={setSendError}
      replyTo={replyTo}
      onClearReplyTo={() => setReplyTo(null)}
      onOpenReplySource={onOpenReplySource}
      highlightedMentions={selectedMentions}
      onComposerKeyDown={handleMentionKeyDown}
      caretRequest={caretRequest}
      mentionMenuOpen={mentionPickerOpen}
      mentionListboxId={mentionListboxId}
      activeMentionOptionId={`${mentionListboxId}-${activeMentionIndex}`}
      rightExtra={
        modelsSupported && catalog && catalog.providers.length > 0 ? (
          <>
            <ModelSelect
              key={`model:${sessionKey}`}
              provider={sessionProvider}
              value={overrideModel}
              onChange={selectModel}
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
              model={effectiveModel}
              value={overrideReasoningEffort}
              onChange={setOverrideReasoningEffort}
              label={t("session.compose.reasoningEffort")}
              className="model-select-compact"
              defaultLabel={t("model.default")}
              defaultId={inheritedEffortId}
            />
            )}
          </>
        ) : undefined
      }
    />
    </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
