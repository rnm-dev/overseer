import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { writePrivateFileDurably, ensurePrivateDirectory, secureExistingPrivateFile } from "../durablePrivateFile.js";
import { stateDir } from "../xdgPaths.js";
import { settings, type DaemonConfigurationView, type SettingsService } from "./settingsService.js";

export const DAEMON_CONFIGURATION_CAPABILITY = "daemon-configuration-v1";
export const DAEMON_CONFIGURATION_SCHEMA_VERSION = 1;

export interface DaemonConfigurationIdentity {
  epoch: string;
  revision: number;
  schemaVersion: 1;
  digest: string;
  updatedAt: number;
}

export interface DaemonConfigurationSnapshot extends DaemonConfigurationIdentity {
  values: DaemonConfigurationView;
}

interface StoredIdentity extends DaemonConfigurationIdentity {
  version: 1;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

export function daemonConfigurationDigest(values: DaemonConfigurationView): string {
  return createHash("sha256").update(canonical(values)).digest("hex");
}

function valid(value: unknown): value is StoredIdentity {
  const item = value as Partial<StoredIdentity> | null;
  return Boolean(item) && item!.version === 1 && item!.schemaVersion === 1
    && typeof item!.epoch === "string" && item!.epoch.length > 0
    && Number.isSafeInteger(item!.revision) && item!.revision! >= 0
    && typeof item!.digest === "string" && /^[a-f0-9]{64}$/.test(item!.digest)
    && Number.isSafeInteger(item!.updatedAt) && item!.updatedAt! >= 0;
}

export class DaemonConfigurationState {
  private identity: StoredIdentity;

  constructor(
    private readonly filePath = path.join(stateDir(), "daemon-configuration-v1.json"),
    private readonly now: () => number = Date.now,
    private readonly configuration: SettingsService = settings,
  ) {
    this.identity = this.load();
    this.reconcile();
  }

  snapshot(): DaemonConfigurationSnapshot {
    const values = this.configuration.getDaemonConfigurationView();
    return { ...this.identity, values };
  }

  reconcile(): { changed: boolean; snapshot: DaemonConfigurationSnapshot } {
    const values = this.configuration.getDaemonConfigurationView();
    const digest = daemonConfigurationDigest(values);
    if (digest === this.identity.digest) return { changed: false, snapshot: { ...this.identity, values } };
    const next: StoredIdentity = {
      ...this.identity,
      revision: this.identity.revision + 1,
      digest,
      updatedAt: this.now(),
    };
    this.persist(next);
    this.identity = next;
    return { changed: true, snapshot: { ...next, values } };
  }

  private load(): StoredIdentity {
    secureExistingPrivateFile(this.filePath);
    try {
      if (existsSync(this.filePath)) {
        const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
        if (valid(parsed)) return parsed;
      }
    } catch {
      // A corrupt identity is reset to a new epoch; settings remain authoritative.
    }
    const values = this.configuration.getDaemonConfigurationView();
    const initial: StoredIdentity = {
      version: 1,
      epoch: randomUUID(),
      revision: 0,
      schemaVersion: 1,
      digest: daemonConfigurationDigest(values),
      updatedAt: this.now(),
    };
    this.persist(initial);
    return initial;
  }

  private persist(value: StoredIdentity): void {
    ensurePrivateDirectory(path.dirname(this.filePath));
    writePrivateFileDurably(this.filePath, JSON.stringify(value, null, 2));
  }
}
