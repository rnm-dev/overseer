import type { LucideIcon } from "lucide-react";
import {
  Database,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileVideo,
} from "lucide-react";

type FileKind =
  | "archive"
  | "audio"
  | "code"
  | "config"
  | "data"
  | "database"
  | "image"
  | "javascript"
  | "json"
  | "shell"
  | "stylesheet"
  | "text"
  | "typescript"
  | "video"
  | "web"
  | "unknown";

const EXTENSION_KINDS: Record<string, FileKind> = {
  // JavaScript and TypeScript get distinct colors because they are common in project trees.
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  html: "web", htm: "web", vue: "web", svelte: "web", astro: "web",
  css: "stylesheet", scss: "stylesheet", sass: "stylesheet", less: "stylesheet", styl: "stylesheet",
  py: "code", rb: "code", php: "code", java: "code", kt: "code", kts: "code",
  go: "code", rs: "code", c: "code", h: "code", cpp: "code", cc: "code", cxx: "code",
  cs: "code", swift: "code", scala: "code", ex: "code", exs: "code", lua: "code",
  json: "json", jsonc: "json", json5: "json", geojson: "json",
  yaml: "config", yml: "config", toml: "config", ini: "config", conf: "config", env: "config",
  properties: "config", xml: "config", lock: "config",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ps1: "shell", bat: "shell", cmd: "shell",
  md: "text", mdx: "text", txt: "text", rst: "text", log: "text", tex: "text", adoc: "text",
  csv: "data", tsv: "data", xls: "data", xlsx: "data", ods: "data", parquet: "data",
  sql: "database", db: "database", sqlite: "database", sqlite3: "database",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image",
  bmp: "image", ico: "image", avif: "image", tif: "image", tiff: "image", psd: "image",
  mp3: "audio", wav: "audio", ogg: "audio", flac: "audio", m4a: "audio", aac: "audio",
  mp4: "video", webm: "video", mov: "video", avi: "video", mkv: "video", m4v: "video",
  zip: "archive", gz: "archive", tgz: "archive", bz2: "archive", xz: "archive", rar: "archive",
  "7z": "archive", tar: "archive", jar: "archive", war: "archive", pdf: "archive",
};

const KIND_APPEARANCE: Record<FileKind, { icon: LucideIcon; color: string }> = {
  archive: { icon: FileArchive, color: "text-amber-500" },
  audio: { icon: FileAudio, color: "text-fuchsia-400" },
  code: { icon: FileCode, color: "text-sky-400" },
  config: { icon: FileCog, color: "text-violet-400" },
  data: { icon: FileSpreadsheet, color: "text-emerald-400" },
  database: { icon: Database, color: "text-cyan-400" },
  image: { icon: FileImage, color: "text-pink-400" },
  javascript: { icon: FileCode, color: "text-yellow-400" },
  json: { icon: FileJson, color: "text-orange-400" },
  shell: { icon: FileTerminal, color: "text-lime-400" },
  stylesheet: { icon: FileCode, color: "text-purple-400" },
  text: { icon: FileText, color: "text-blue-300" },
  typescript: { icon: FileCode, color: "text-blue-400" },
  video: { icon: FileVideo, color: "text-rose-400" },
  web: { icon: FileCode, color: "text-orange-500" },
  unknown: { icon: File, color: "text-bone-faint" },
};

export function fileKindForName(name: string): FileKind {
  const basename = name.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (basename === "dockerfile" || basename === "makefile" || basename === "justfile") return "shell";
  const dot = basename.lastIndexOf(".");
  if (dot < 0 || dot === basename.length - 1) return "unknown";
  return EXTENSION_KINDS[basename.slice(dot + 1)] ?? "unknown";
}

export function FileTypeIcon({ name, size = 15, className = "" }: { name: string; size?: number; className?: string }) {
  const appearance = KIND_APPEARANCE[fileKindForName(name)];
  const Icon = appearance.icon;
  return <Icon size={size} className={`flex-none ${appearance.color} ${className}`} aria-hidden />;
}
