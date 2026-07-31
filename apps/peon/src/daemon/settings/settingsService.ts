import { EventEmitter } from "node:events";
import type { CodingAgent, ReasoningEffort } from "../modelCatalog.js";
import {
  canonicalModel,
  isModelForAgent,
  listConfiguredAgents,
  narrowNewSessionAgent,
  narrowReasoningEffort,
  providerDefaultModel,
  reasoningEffortsForModel,
} from "../modelCatalog.js";
import type { DaemonSettings } from "./settingsTypes.js";
import { SettingsStore } from "./settingsStore.js";

type SettingsBody = Record<string, unknown>;

type ModelValue = string | null | undefined;
function parseModelValue(value: unknown): ModelValue {
  return typeof value === "string" || value === null || value === undefined ? value : undefined;
}

type EffortValue = string | null | undefined;
function parseEffortValue(value: unknown): EffortValue {
  return typeof value === "string" || value === null || value === undefined ? value : undefined;
}

function modelDefaultEffort(agent: CodingAgent, model: string | null): ReasoningEffort | null {
  return reasoningEffortsForModel(agent, model ?? providerDefaultModel(agent)).find((item) => item.default)?.id ?? null;
}

export interface SettingsReader {
  get(): DaemonSettings;
}

export interface SettingsUpdate {
  update(patch: Partial<DaemonSettings>): DaemonSettings;
}

export interface SettingsPatchError {
  code: "BAD_REQUEST";
  error: string;
}

export interface PeonSocketSettings {
  overseerUrl: string;
  overseerToken: string;
  peonId?: string;
}

export interface PeonRegistrarSettings {
  name: string;
  overseerUrl: string;
  overseerToken: string;
  fileTransferRoot: string;
  heartbeatIntervalMs: number;
  paused: boolean;
}

export interface UpdateCheckerSettings {
  updateCheckIntervalMs: number;
  overseerUrl: string;
  overseerToken: string;
}

export interface FleetSettingsView {
  name: string | null;
  paused: boolean;
  defaultAgent: CodingAgent;
  fileTransferRoot: string | null;
  heartbeatIntervalMs: number;
  aiDefaultModel: string | null;
  aiDefaultReasoningEffort: ReasoningEffort | null;
  soul: string | null;
}

export interface DaemonConfigurationView {
  name: string | null;
  defaultAgent: CodingAgent;
  fileTransferRoot: string | null;
  heartbeatIntervalMs: number;
  aiDefaultModel: string | null;
  aiDefaultReasoningEffort: ReasoningEffort | null;
  soul: string | null;
}

export interface ControlSettingsView extends Omit<DaemonSettings, "overseerToken" | "pairingSecret"> {
  overseerTokenSet: boolean;
  pairingArmed: boolean;
  aiDefaultModel: string | null;
  aiDefaultReasoningEffort: ReasoningEffort | null;
  soul: string | null;
}

export interface SettingsChangeSubscription {
  on(event: "change", listener: (settings: DaemonSettings) => void): this;
}

export type SettingsServiceContract = SettingsReader & SettingsUpdate & SettingsChangeSubscription;

export class SettingsService extends EventEmitter implements SettingsServiceContract {
  constructor(private readonly store: SettingsStore = new SettingsStore()) {
    super();
  }

  get(): DaemonSettings {
    return this.store.get();
  }

  getPeonSocketSettings(): PeonSocketSettings {
    const s = this.get();
    return {
      overseerUrl: s.overseerUrl,
      overseerToken: s.overseerToken,
      ...(s.peonId.trim() ? { peonId: s.peonId } : {}),
    };
  }

  getPeonRegistrarSettings(): PeonRegistrarSettings {
    const s = this.get();
    return {
      name: s.name,
      overseerUrl: s.overseerUrl,
      overseerToken: s.overseerToken,
      fileTransferRoot: s.fileTransferRoot || "",
      heartbeatIntervalMs: s.heartbeatIntervalMs,
      paused: s.paused,
    };
  }

  getUpdateCheckerSettings(): UpdateCheckerSettings {
    const s = this.get();
    return {
      updateCheckIntervalMs: s.updateCheckIntervalMs,
      overseerUrl: s.overseerUrl,
      overseerToken: s.overseerToken,
    };
  }

  getFleetSettingsView(): FleetSettingsView {
    const s = this.get();
    return {
      name: s.name || null,
      paused: s.paused,
      defaultAgent: s.defaultAgent,
      fileTransferRoot: s.fileTransferRoot || null,
      heartbeatIntervalMs: s.heartbeatIntervalMs,
      aiDefaultModel: s.ai.defaultModel ?? null,
      aiDefaultReasoningEffort: s.ai.defaultReasoningEffort ?? null,
      soul: s.ai.soul || null,
    };
  }

  getDaemonConfigurationView(settings = this.get()): DaemonConfigurationView {
    return {
      name: settings.name || null,
      defaultAgent: settings.defaultAgent,
      fileTransferRoot: settings.fileTransferRoot || null,
      heartbeatIntervalMs: settings.heartbeatIntervalMs,
      aiDefaultModel: settings.ai.defaultModel ?? null,
      aiDefaultReasoningEffort: settings.ai.defaultReasoningEffort ?? null,
      soul: settings.ai.soul || null,
    };
  }

  patchDaemonConfiguration(body: unknown): { settings: DaemonSettings; view: DaemonConfigurationView } {
    const current = this.get();
    const patch = this.normalizeDaemonConfigurationPatch(body, current);
    if (Object.keys(patch).length === 0) return { settings: current, view: this.getDaemonConfigurationView(current) };
    const updated = this.update(patch);
    return { settings: updated, view: this.getDaemonConfigurationView(updated) };
  }

  previewDaemonConfiguration(body: unknown): DaemonConfigurationView {
    const current = this.get();
    const patch = this.normalizeDaemonConfigurationPatch(body, current);
    return this.getDaemonConfigurationView({
      ...current,
      ...patch,
      ...(patch.ai ? { ai: { ...current.ai, ...patch.ai } } : {}),
    });
  }

  private normalizeDaemonConfigurationPatch(body: unknown, current: DaemonSettings): Partial<DaemonSettings> {
    const value = this.ensureRecord(body);
    const allowed = new Set([
      "name", "defaultAgent", "fileTransferRoot", "heartbeatIntervalMs",
      "aiDefaultModel", "aiDefaultReasoningEffort", "soul",
    ]);
    const unknown = Object.keys(value).find((key) => !allowed.has(key));
    if (unknown) this.throwBadRequest(`${unknown} is not remotely manageable`);
    if (Object.keys(value).length === 0) return {};
    if (typeof value.name === "string" && Buffer.byteLength(value.name) > 200) {
      this.throwBadRequest("name exceeds 200 UTF-8 bytes");
    }
    if (typeof value.fileTransferRoot === "string" && Buffer.byteLength(value.fileTransferRoot) > 4096) {
      this.throwBadRequest("fileTransferRoot exceeds 4096 UTF-8 bytes");
    }
    if (typeof value.soul === "string" && Buffer.byteLength(value.soul) > 48 * 1024) {
      this.throwBadRequest("soul exceeds 49152 UTF-8 bytes");
    }

    const normalized: SettingsBody = { ...value };
    for (const nullable of ["name", "fileTransferRoot", "soul"]) {
      if (nullable in normalized && normalized[nullable] === null) normalized[nullable] = "";
    }
    const { name, ...fleetValues } = normalized;
    const patch = this.validateAndNormalizeFleetPatch(fleetValues, current);
    if ("name" in normalized) {
      if (typeof name !== "string") this.throwBadRequest("name must be a string or null");
      patch.name = name;
    }
    return patch;
  }

  getControlSettingsView(s = this.get()): ControlSettingsView {
    // Never hand durable credentials to a browser. Besides exposing a full-admin
    // secret, the old response let a stale Settings tab send an obsolete token
    // back with an unrelated edit and silently break enrollment.
    const safe = { ...s } as Record<string, unknown>;
    for (const key of ["overseerToken", "pairingSecret", "strongholdToken"]) delete safe[key];
    return {
      ...safe,
      overseerTokenSet: Boolean(s.overseerToken),
      pairingArmed: Boolean(s.pairingSecret && s.pairingSecretExpiresAt > Date.now()),
      aiDefaultModel: s.ai.defaultModel ?? null,
      aiDefaultReasoningEffort: s.ai.defaultReasoningEffort ?? null,
      soul: s.ai.soul || null,
    } as unknown as ControlSettingsView;
  }

  patchFleetSettings(body: unknown): { settings: DaemonSettings; view: FleetSettingsView } {
    const patch = this.validateAndNormalizeFleetPatch(body, this.get());
    const updated = Object.keys(patch).length === 0 ? this.get() : this.update(patch);
    return { settings: updated, view: this.getFleetSettingsViewFrom(updated) };
  }

  patchControlSettings(body: unknown): { settings: DaemonSettings; view: ControlSettingsView } {
    const patch = this.validateAndNormalizeControlPatch(body, this.get());
    const updated = Object.keys(patch).length === 0 ? this.get() : this.update(patch);
    return { settings: updated, view: this.getControlSettingsView(updated) };
  }

  update(patch: Partial<DaemonSettings>): DaemonSettings {
    const updated = this.store.update(patch);
    this.emit("change", updated);
    return updated;
  }

  private validateAndNormalizeFleetPatch(payload: unknown, current: DaemonSettings): Partial<DaemonSettings> {
    const body = this.ensureRecord(payload);
    const patch: Partial<DaemonSettings> = {};

    if ("paused" in body) {
      if (typeof body.paused !== "boolean") this.throwBadRequest("paused must be a boolean");
      patch.paused = body.paused;
    }

    if ("name" in body) {
      const name = body.name;
      if (typeof name !== "string" || name.trim() === "") this.throwBadRequest("name must be a non-empty string");
      patch.name = name;
    }

    if ("fileTransferRoot" in body) {
      const fileTransferRoot = body.fileTransferRoot;
      if (typeof fileTransferRoot !== "string") {
        this.throwBadRequest("fileTransferRoot must be a string (empty string disables file transfer)");
      }
      patch.fileTransferRoot = fileTransferRoot;
    }

    if ("defaultAgent" in body) {
      const agent = narrowNewSessionAgent(body.defaultAgent);
      if (!agent) {
        this.throwBadRequest(`defaultAgent must be one of: ${this.listAgents()}`);
      }
      patch.defaultAgent = agent;
    }

    if ("heartbeatIntervalMs" in body) {
      const heartbeatIntervalMs = body.heartbeatIntervalMs;
      if (typeof heartbeatIntervalMs !== "number" || !Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs < 1000 || heartbeatIntervalMs > 60_000) {
        this.throwBadRequest("heartbeatIntervalMs must be a number between 1000 and 60000");
      }
      patch.heartbeatIntervalMs = heartbeatIntervalMs;
    }

    if ("soul" in body) {
      const soul = body.soul;
      if (typeof soul !== "string") this.throwBadRequest("soul must be a string (empty string disables it)");
      patch.ai = { ...current.ai, soul };
    }

    const candidateAgent = patch.defaultAgent ?? current.defaultAgent;
    if ("aiDefaultModel" in body) {
      const model = parseModelValue(body.aiDefaultModel);
      if (model !== null && !isModelForAgent(candidateAgent, model)) {
        this.throwBadRequest(`aiDefaultModel is not valid for defaultAgent ${candidateAgent}`);
      }
      if (model === null) {
        patch.ai = { ...current.ai, ...patch.ai, defaultModel: null };
      } else {
        const canonical = canonicalModel(candidateAgent, model);
        if (canonical === undefined) this.throwBadRequest(`aiDefaultModel is not valid for defaultAgent ${candidateAgent}`);
        patch.ai = { ...current.ai, ...patch.ai, defaultModel: canonical };
      }
    } else if (patch.defaultAgent && current.ai.defaultModel !== null && !isModelForAgent(candidateAgent, current.ai.defaultModel)) {
      patch.ai = { ...current.ai, ...patch.ai, defaultModel: null };
    }

    const effectiveModel = patch.ai?.defaultModel ?? current.ai.defaultModel;
    if ("aiDefaultReasoningEffort" in body) {
      const effort = parseEffortValue(body.aiDefaultReasoningEffort);
      if (effort === undefined) this.throwBadRequest("aiDefaultReasoningEffort must be a string or null");
      const normalized = effort === null ? null : narrowReasoningEffort(effort, candidateAgent, effectiveModel);
      if (effort !== null && !normalized) {
        this.throwBadRequest(`aiDefaultReasoningEffort is not valid for model ${effectiveModel ?? providerDefaultModel(candidateAgent)}`);
      }
      patch.ai = { ...current.ai, ...patch.ai, defaultReasoningEffort: normalized ?? null };
    } else if (
      (patch.defaultAgent || patch.ai?.defaultModel !== undefined)
      && current.ai.defaultReasoningEffort !== null
      && !narrowReasoningEffort(current.ai.defaultReasoningEffort, candidateAgent, effectiveModel)
    ) {
      patch.ai = { ...current.ai, ...patch.ai, defaultReasoningEffort: modelDefaultEffort(candidateAgent, effectiveModel) };
    }

    return patch;
  }

  private validateAndNormalizeControlPatch(payload: unknown, current: DaemonSettings): Partial<DaemonSettings> {
    const body = this.ensureRecord(payload);
    const managedCredential = [
      "overseerToken",
      "pairingSecret",
      "pairingSecretExpiresAt",
      "peonId",
      "strongholdToken",
    ].find((key) => key in body);
    if (managedCredential) {
      this.throwBadRequest(`${managedCredential} is managed by enrollment and cannot be changed through general settings`);
    }
    const patch = { ...body } as Partial<DaemonSettings>;
    // Rolling upgrades may still submit the retired topology field. Ignore it:
    // authenticated Fleet HTTP is the single supported transport policy.
    delete (patch as unknown as Record<string, unknown>).fleetMode;
    const requestedAgent = "defaultAgent" in body ? narrowNewSessionAgent(body.defaultAgent) : current.defaultAgent;
    if (!requestedAgent) {
      this.throwBadRequest(`defaultAgent must be one of: ${this.listAgents()}`);
    }

    const flatModelProvided = "aiDefaultModel" in body;
    const nestedModelProvided = typeof body.ai === "object" && body.ai !== null && "defaultModel" in body.ai;
    const flatEffortProvided = "aiDefaultReasoningEffort" in body;
    const nestedEffortProvided = typeof body.ai === "object" && body.ai !== null && "defaultReasoningEffort" in body.ai;
    const flatSoulProvided = "soul" in body;
    const nestedSoulProvided = typeof body.ai === "object" && body.ai !== null && "soul" in body.ai;
    const requestedSoul = flatSoulProvided
      ? body.soul
      : nestedSoulProvided
        ? (body.ai as { soul?: unknown }).soul
        : current.ai.soul;

    if ((flatSoulProvided || nestedSoulProvided) && requestedSoul !== null && typeof requestedSoul !== "string") {
      this.throwBadRequest("soul must be a string or null");
    }

    const requestedModel = flatModelProvided
      ? parseModelValue(body.aiDefaultModel)
      : nestedModelProvided
        ? parseModelValue((body.ai as { defaultModel?: unknown }).defaultModel)
        : current.ai.defaultModel;

    if ((flatModelProvided || nestedModelProvided) && requestedModel !== null && !isModelForAgent(requestedAgent, requestedModel)) {
      this.throwBadRequest(`aiDefaultModel is not valid for defaultAgent ${requestedAgent}`);
    }

    const agentChanged = requestedAgent !== current.defaultAgent;
    const normalizedModel = ((): string | null => {
      if (!flatModelProvided && !nestedModelProvided) {
        return agentChanged && current.ai.defaultModel !== null && !isModelForAgent(requestedAgent, current.ai.defaultModel)
          ? null
          : current.ai.defaultModel;
      }
      if (requestedModel === null) return null;
      const canonical = canonicalModel(requestedAgent, requestedModel);
      if (canonical === undefined) this.throwBadRequest(`aiDefaultModel is not valid for defaultAgent ${requestedAgent}`);
      return canonical;
    })();
    const requestedEffort = flatEffortProvided
      ? parseEffortValue(body.aiDefaultReasoningEffort)
      : nestedEffortProvided
        ? parseEffortValue((body.ai as { defaultReasoningEffort?: unknown }).defaultReasoningEffort)
        : current.ai.defaultReasoningEffort;
    if ((flatEffortProvided || nestedEffortProvided) && requestedEffort === undefined) {
      this.throwBadRequest("aiDefaultReasoningEffort must be a string or null");
    }
    const modelChanged = normalizedModel !== current.ai.defaultModel;
    const normalizedEffort = ((): ReasoningEffort | null => {
      if (!flatEffortProvided && !nestedEffortProvided && (agentChanged || modelChanged)) {
        return current.ai.defaultReasoningEffort !== null
          && narrowReasoningEffort(current.ai.defaultReasoningEffort, requestedAgent, normalizedModel)
          ? current.ai.defaultReasoningEffort
          : modelDefaultEffort(requestedAgent, normalizedModel);
      }
      if (requestedEffort === null || requestedEffort === undefined) return null;
      const canonical = narrowReasoningEffort(requestedEffort, requestedAgent, normalizedModel);
      if (!canonical) {
        this.throwBadRequest(`aiDefaultReasoningEffort is not valid for model ${normalizedModel ?? providerDefaultModel(requestedAgent)}`);
      }
      return canonical;
    })();
    delete (patch as Record<string, unknown>).aiDefaultModel;
    delete (patch as Record<string, unknown>).aiDefaultReasoningEffort;
    delete (patch as Record<string, unknown>).soul;
    patch.defaultAgent = requestedAgent;
    const requestedAi = typeof body.ai === "object" && body.ai !== null
      ? body.ai as Partial<DaemonSettings["ai"]>
      : {};
    patch.ai = {
      ...current.ai,
      ...requestedAi,
      defaultModel: normalizedModel,
      defaultReasoningEffort: normalizedEffort,
      soul: typeof requestedSoul === "string" ? requestedSoul : "",
    };
    return patch;
  }

  private getFleetSettingsViewFrom(settings: DaemonSettings): FleetSettingsView {
    return {
      name: settings.name || null,
      paused: settings.paused,
      defaultAgent: settings.defaultAgent,
      fileTransferRoot: settings.fileTransferRoot || null,
      heartbeatIntervalMs: settings.heartbeatIntervalMs,
      aiDefaultModel: settings.ai.defaultModel ?? null,
      aiDefaultReasoningEffort: settings.ai.defaultReasoningEffort ?? null,
      soul: settings.ai.soul || null,
    };
  }

  private throwBadRequest(error: string): never {
    const e = new Error(error) as Error & SettingsPatchError;
    e.code = "BAD_REQUEST";
    e.error = error;
    throw e;
  }

  private listAgents(): string {
    return listConfiguredAgents({ visible: true, available: true }).join(", ");
  }

  private ensureRecord(payload: unknown): SettingsBody {
    if (payload === null || typeof payload !== "object") return {};
    return payload as SettingsBody;
  }
}

export const settings = new SettingsService();
