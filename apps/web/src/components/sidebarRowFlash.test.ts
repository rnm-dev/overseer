import assert from "node:assert/strict";
import test from "node:test";
import { changedRowKeys, rowEdgeClass, SIDEBAR_ROW_EDGE_CLASS } from "./SidebarSectionHeader";
import { sessionRowFingerprint } from "./SessionSidebarList";
import type { SessionLite } from "../pages/peon/sessionList";
import { projectRowFingerprint } from "./ProjectSidebarSection";

test("a row flashes when its live fingerprint moves or it arrives, not when it is unchanged", () => {
  const seen = new Map([["peon\0a", "fp-a"], ["peon\0b", "fp-b"], ["peon\0gone", "fp-gone"]]);
  const current = new Map([["peon\0a", "fp-a"], ["peon\0b", "fp-b2"], ["peon\0new", "fp-new"]]);

  assert.deepEqual(changedRowKeys(seen, current), ["peon\0b", "peon\0new"]);
  assert.deepEqual(changedRowKeys(current, current), []);
});

test("session fingerprints track every field a live update can move", () => {
  const base = { peonId: "p", id: "s", status: "running", lastActivityAt: 10, lastMessagePreview: "one", title: "T" };
  assert.equal(sessionRowFingerprint(base), sessionRowFingerprint({ ...base }));
  const changes: Partial<SessionLite>[] = [
    { status: "completed" },
    { lastActivityAt: 11 },
    { lastMessagePreview: "two" },
    { title: "T2" },
    { attentionUnread: true },
    { catalogState: "syncing" },
  ];
  for (const change of changes) {
    assert.notEqual(sessionRowFingerprint({ ...base, ...change }), sessionRowFingerprint(base), JSON.stringify(change));
  }
  // Presence and ordering are not session news; they must not flash the row.
  assert.equal(sessionRowFingerprint({ ...base, projectKey: "OVSR" }), sessionRowFingerprint(base));
});

test("project fingerprints track the live counts the row renders", () => {
  const base = { key: "OVSR", name: "Overseer", activeCount: 1, sessionCount: 8, unreadCount: 0 };
  assert.equal(projectRowFingerprint(base), projectRowFingerprint({ ...base }));
  // lastActivityMs is stamped from the project's sessions, so work moving inside
  // a project flashes its row even when every count stays the same.
  for (const change of [{ name: "Renamed" }, { activeCount: 2 }, { sessionCount: 9 }, { unreadCount: 2 }, { lastActivityMs: 99 }]) {
    assert.notEqual(projectRowFingerprint({ ...base, ...change }), projectRowFingerprint(base), JSON.stringify(change));
  }
  // The member count left the row, so it must no longer flash it.
  assert.equal(projectRowFingerprint({ ...base, memberCount: 4 }), projectRowFingerprint(base));
});

test("the flash class rides along only while a row holds a flash nonce", () => {
  assert.equal(rowEdgeClass("bg-fel-bright status-edge", 0), `${SIDEBAR_ROW_EDGE_CLASS} bg-fel-bright status-edge`);
  assert.equal(rowEdgeClass("bg-fel-bright status-edge", undefined), `${SIDEBAR_ROW_EDGE_CLASS} bg-fel-bright status-edge`);
  assert.equal(rowEdgeClass("bg-bone-faint/40", 3), `${SIDEBAR_ROW_EDGE_CLASS} bg-bone-faint/40 status-edge-flash`);
});
