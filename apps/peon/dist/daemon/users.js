import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configDir } from "./xdgPaths.js";
const STATE_PATH = path.join(configDir(), "users.json");
const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
// Every install has this user from the very first boot — loopback callers
// (the CLI, scripts, anything on the same box) are attributed to it, so
// there's always a real identity behind "authenticated", never a null one.
export const DEFAULT_ADMIN_USERNAME = "admin";
// Trims/lowercases so "Alice" and "alice " land on the same record, then
// validates against a conservative charset (safe in URLs/CLI args/file paths
// without escaping). Returns null rather than throwing so callers can turn
// it into a 400 with their own message.
export function normalizeUsername(raw) {
    const username = raw.trim().toLowerCase();
    return USERNAME_RE.test(username) ? username : null;
}
function read() {
    if (!existsSync(STATE_PATH))
        return {};
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}
class UserStore extends EventEmitter {
    users;
    constructor() {
        super();
        this.users = read();
        this.ensure(DEFAULT_ADMIN_USERNAME); // no-op once already persisted from a prior run
    }
    persist() {
        mkdirSync(path.dirname(STATE_PATH), { recursive: true });
        writeFileSync(STATE_PATH, JSON.stringify(this.users, null, 2), { mode: 0o600 });
    }
    list() {
        return Object.values(this.users);
    }
    get(username) {
        return this.users[username];
    }
    // Idempotent create-if-missing, same idiom as projectStore.ensure().
    ensure(username) {
        const existing = this.users[username];
        if (existing)
            return existing;
        const record = { username, createdAt: Date.now() };
        this.users[username] = record;
        this.persist();
        this.emit("change", record);
        return record;
    }
    // Explicit create — reports whether the user already existed so callers can
    // tell "created" from "already there" (auth-link no longer creates users, so
    // creation now goes through this single, intentional path).
    create(username) {
        const existing = this.users[username];
        if (existing)
            return { record: existing, created: false };
        return { record: this.ensure(username), created: true };
    }
}
export const users = new UserStore();
