#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const write = process.argv.includes("--write");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : Infinity;
if (!(limit === Infinity || Number.isInteger(limit) && limit > 0)) {
  throw new Error("--limit must be a positive integer");
}

const stateRoot = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), ".peon", "sessions");
const codexRoot = path.join(os.homedir(), ".codex", "sessions");
const claudeRoot = path.join(os.homedir(), ".claude", "projects");

if (write) {
  const port = process.env.ACA_CONTROL_PORT ?? "4570";
  const daemonRunning = await fetch(`http://127.0.0.1:${port}/api/v1/status`, {
    signal: AbortSignal.timeout(750),
  }).then((response) => response.ok).catch(() => false);
  if (daemonRunning) {
    throw new Error("refusing to rewrite transcripts while the Peon daemon is running; stop it first");
  }
}

function jsonLines(file) {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function indexJsonlFiles(root, index = new Map()) {
  if (!existsSync(root)) return index;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) indexJsonlFiles(target, index);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) index.set(entry.name, target);
  }
  return index;
}

function providerMessages(record, nativeFile) {
  const rows = jsonLines(nativeFile);
  if (record.agent === "codex") {
    return rows
      .filter((row) => row.type === "event_msg" && row.payload?.type === "user_message")
      .map((row) => ({ timestamp: row.timestamp, text: row.payload.message }));
  }
  return rows
    .filter((row) => row.type === "user" && typeof row.message?.content === "string")
    .map((row) => ({ timestamp: row.timestamp, text: row.message.content }));
}

function validTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12
    && Number(dayText) >= 1 && Number(dayText) <= days[month - 1]
    && Number(hourText) <= 23 && Number(minuteText) <= 59 && Number(secondText) <= 59
    && (offsetHourText === undefined || Number(offsetHourText) <= 23)
    && (offsetMinuteText === undefined || Number(offsetMinuteText) <= 59)
    && Number.isFinite(Date.parse(value));
}

// Peon stores the human's original text while Codex prefixes system context
// and may suffix attachment paths. Longest-common-subsequence matching keeps
// order and handles queued Peon messages that never reached the provider.
function matchProviderMessages(rows, userIndexes, provider) {
  const result = [];
  let providerIndex = 0;
  for (const rowIndex of userIndexes) {
    const text = rows[rowIndex]?.text;
    if (typeof text !== "string" || text.length === 0) continue;
    let matchedAt = providerIndex;
    while (matchedAt < provider.length) {
      const candidate = provider[matchedAt];
      if (typeof candidate.text === "string" && candidate.text.includes(text)) break;
      matchedAt += 1;
    }
    if (matchedAt < provider.length) {
      result.push([rowIndex, provider[matchedAt]]);
      providerIndex = matchedAt + 1;
    }
  }
  return result;
}

function legacyEventId(sessionId, line, lineNumber) {
  return `legacy_${createHash("sha256").update(sessionId).update("\0").update(String(lineNumber)).update("\0").update(line).digest("base64url")}`;
}

function preserveEventIds(sessionId, parsedLines) {
  const seen = new Set();
  for (const entry of parsedLines) {
    if (!entry.row) continue;
    const fallback = legacyEventId(sessionId, entry.raw, entry.lineNumber);
    const stored = entry.row._peonEventId;
    let eventId = typeof stored === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(stored) ? stored : fallback;
    for (let duplicate = 1; seen.has(eventId); duplicate += 1) eventId = `${fallback}_${duplicate}`;
    seen.add(eventId);
    entry.row._peonEventId = eventId;
  }
}

const codexFiles = indexJsonlFiles(codexRoot);
const claudeFiles = indexJsonlFiles(claudeRoot);
const summaries = (existsSync(stateRoot) ? readdirSync(stateRoot) : [])
  .filter((name) => name.endsWith(".summary.json"))
  .map((name) => path.join(stateRoot, name))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  .slice(0, limit);

const report = { mode: write ? "write" : "dry-run", scanned: 0, repairableSessions: 0, repairedMessages: 0, unrepairedMessages: 0, skipped: [] };
for (const summaryFile of summaries) {
  report.scanned++;
  let record;
  try {
    record = JSON.parse(readFileSync(summaryFile, "utf8"));
  } catch (error) {
    report.skipped.push({ id: path.basename(summaryFile), reason: `unreadable summary: ${error instanceof Error ? error.message : String(error)}` });
    continue;
  }
  const transcriptFile = path.join(stateRoot, `${record.id}.jsonl`);
  if (!existsSync(transcriptFile) || !record.backendSessionId) {
    report.skipped.push({ id: record.id, reason: "missing transcript or backend session id" });
    continue;
  }
  const transcriptVersion = statSync(transcriptFile);
  const nativeName = record.agent === "codex"
    ? [...codexFiles.keys()].find((name) => name.endsWith(`-${record.backendSessionId}.jsonl`))
    : `${record.backendSessionId}.jsonl`;
  const nativeFile = nativeName
    ? (record.agent === "codex" ? codexFiles.get(nativeName) : claudeFiles.get(nativeName))
    : undefined;
  if (!nativeFile) {
    report.skipped.push({ id: record.id, reason: "native transcript unavailable" });
    continue;
  }

  const physicalLines = readFileSync(transcriptFile, "utf8").split("\n");
  const parsedLines = physicalLines.map((raw, lineNumber) => {
    if (!raw) return { raw, lineNumber, row: null };
    try { return { raw, lineNumber, row: JSON.parse(raw) }; }
    catch { return { raw, lineNumber, row: null }; }
  });
  if (write) preserveEventIds(record.id, parsedLines);
  const rows = parsedLines.filter((entry) => entry.row).map((entry) => entry.row);
  const userIndexes = rows.flatMap((row, index) => row.type === "user_message" ? [index] : []);
  let provider;
  try {
    provider = providerMessages(record, nativeFile);
  } catch (error) {
    report.skipped.push({ id: record.id, reason: `unreadable provider transcript: ${error instanceof Error ? error.message : String(error)}` });
    continue;
  }
  if (!provider.every((message) => validTimestamp(message.timestamp))) {
    report.skipped.push({
      id: record.id,
      reason: "provider transcript contains an invalid timestamp",
    });
    continue;
  }

  let repaired = 0;
  const matched = matchProviderMessages(rows, userIndexes, provider);
  matched.forEach(([rowIndex, message]) => {
    if (typeof rows[rowIndex].createdAt === "number") return;
    rows[rowIndex].createdAt = Date.parse(message.timestamp);
    rows[rowIndex].sourceTimestamp ??= message.timestamp;
    repaired++;
  });
  const remaining = userIndexes.filter((rowIndex) => typeof rows[rowIndex].createdAt !== "number").length;
  report.unrepairedMessages += remaining;
  if (remaining > 0) {
    report.skipped.push({
      id: record.id,
      reason: "provider did not record every Peon user message",
      peonMessages: userIndexes.length,
      providerMessages: provider.length,
      repaired,
      remaining,
    });
  }
  if (repaired === 0) continue;
  report.repairableSessions++;
  report.repairedMessages += repaired;
  if (write) {
    const temporary = `${transcriptFile}.${process.pid}.timestamp-repair.tmp`;
    const output = parsedLines.map((entry) => entry.row ? JSON.stringify(entry.row) : entry.raw).join("\n");
    writeFileSync(temporary, output, { mode: 0o600 });
    const currentVersion = statSync(transcriptFile);
    if (currentVersion.size !== transcriptVersion.size || currentVersion.mtimeMs !== transcriptVersion.mtimeMs) {
      rmSync(temporary, { force: true });
      throw new Error(`transcript changed during repair: ${record.id}`);
    }
    renameSync(temporary, transcriptFile);
  }
}

console.log(JSON.stringify(report, null, 2));
