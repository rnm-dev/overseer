import {
  closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, renameSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { stateDir } from "../runtime/xdgPaths.js";

export type UpdateCommandReceipt = {
  version: 1;
  commandId: string;
  expectedVersion: string | null;
  expectedRevision: string | null;
  expectedSha256: string | null;
  initiatorPid: number;
  state: "running" | "ready_to_attest" | "succeeded" | "failed";
  code?: string;
  attested?: boolean;
  actualVersion?: string | null;
  actualRevision?: string | null;
  actualSha256?: string | null;
  updatedAt: number;
};

const STATES = new Set(["running", "ready_to_attest", "succeeded", "failed"]);
const REVISION = /^[0-9A-Za-z._:+-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function updateCommandReceiptPath(): string {
  return path.join(stateDir(), "update-command-v1.json");
}

export function readUpdateCommandReceipt(): UpdateCommandReceipt | null {
  const file = updateCommandReceiptPath();
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as UpdateCommandReceipt;
    if (value.version !== 1 || typeof value.commandId !== "string"
      || (value.expectedVersion !== null && typeof value.expectedVersion !== "string")
      || (value.expectedRevision !== null
        && (typeof value.expectedRevision !== "string" || !REVISION.test(value.expectedRevision)))
      || (value.expectedSha256 !== null
        && (typeof value.expectedSha256 !== "string" || !SHA256.test(value.expectedSha256)))
      || !Number.isSafeInteger(value.initiatorPid) || value.initiatorPid <= 0
      || !STATES.has(value.state) || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0
      || (value.code !== undefined && (typeof value.code !== "string" || value.code.length > 80))
      || (value.attested !== undefined && typeof value.attested !== "boolean")
      || (value.actualVersion !== undefined && value.actualVersion !== null && typeof value.actualVersion !== "string")
      || (value.actualRevision !== undefined && value.actualRevision !== null
        && (typeof value.actualRevision !== "string" || !REVISION.test(value.actualRevision)))
      || (value.actualSha256 !== undefined && value.actualSha256 !== null
        && (typeof value.actualSha256 !== "string" || !SHA256.test(value.actualSha256)))) return null;
    return value;
  } catch {
    return null;
  }
}

export function writeUpdateCommandReceipt(receipt: UpdateCommandReceipt): void {
  const file = updateCommandReceiptPath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
  const descriptor = openSync(temporary, constants.O_RDWR);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, file);
  if (process.platform !== "win32") {
    const directory = openSync(path.dirname(file), constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
