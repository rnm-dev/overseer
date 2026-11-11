import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rebuildHead, type SignoffEvent, type SignoffHead, type SignoffRecord } from "./model.js";

const FILE_VERSION = 1;

/**
 * Durable sign-off storage: one JSON file per sign-off, written atomically
 * (temp file + rename, as the session summaries are). The store is the only
 * writer, and it only ever appends: a write whose event log does not extend the
 * stored one by exactly the next seq is refused, and stored events are frozen.
 */
export class SignoffStore {
  private readonly records = new Map<string, SignoffRecord>();

  constructor(private readonly dir: string) {}

  load(): void {
    this.records.clear();
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.dir, name);
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: number; head?: SignoffHead; events?: SignoffEvent[] };
        if (parsed.version !== FILE_VERSION || !parsed.head || !Array.isArray(parsed.events)) throw new Error("unrecognised file");
        // The head is a projection of the events; rebuild it rather than trust it.
        const head = rebuildHead(parsed.head, parsed.events);
        this.records.set(head.id, { head, events: freezeEvents(parsed.events) });
      } catch (error) {
        console.error(`signoffs: skipping unreadable ${name}:`, error instanceof Error ? error.message : error);
      }
    }
  }

  get(id: string): SignoffRecord | undefined {
    return this.records.get(id);
  }

  list(): SignoffRecord[] {
    return [...this.records.values()];
  }

  /** Creates a new sign-off. Its log must be exactly one `proposed` event at seq 1. */
  create(head: SignoffHead, event: SignoffEvent): SignoffRecord {
    if (this.records.has(head.id)) throw new Error(`sign-off ${head.id} already exists`);
    if (event.seq !== 1 || event.kind !== "proposed") throw new Error("a sign-off starts with proposed at seq 1");
    const events = freezeEvents([event]);
    const record = { head: rebuildHead(head, events), events };
    this.write(record);
    this.records.set(head.id, record);
    return record;
  }

  /** Appends one event. The only way a stored log ever changes. */
  append(id: string, event: SignoffEvent): SignoffRecord {
    const current = this.records.get(id);
    if (!current) throw new Error(`unknown sign-off ${id}`);
    const nextSeq = current.events.length + 1;
    if (event.seq !== nextSeq) throw new Error(`append-only: expected seq ${nextSeq}, got ${event.seq}`);
    const events = freezeEvents([...current.events, event]);
    const record = { head: rebuildHead(current.head, events), events };
    this.write(record);
    this.records.set(id, record);
    return record;
  }

  /** Changes only the head's orphaned flag; the event log is untouched. */
  markOrphaned(id: string): SignoffRecord | undefined {
    const current = this.records.get(id);
    if (!current || current.head.orphaned) return current;
    const record = { head: { ...current.head, orphaned: true }, events: current.events };
    this.write(record);
    this.records.set(id, record);
    return record;
  }

  private write(record: SignoffRecord): void {
    mkdirSync(this.dir, { recursive: true });
    const target = path.join(this.dir, `${record.head.id}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: FILE_VERSION, head: record.head, events: record.events }), { mode: 0o600 });
      renameSync(temporary, target);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}

function freezeEvents(events: SignoffEvent[]): SignoffEvent[] {
  for (const event of events) deepFreeze(event);
  return Object.freeze(events) as SignoffEvent[];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
