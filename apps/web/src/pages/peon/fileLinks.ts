// Every file this app shows — a message attachment, a project file, a docs
// page, a session artifact — is named by one of these sources, and every URL
// that reads one is built here. A surface that assembles its own path is how
// `/files//tmp/peon-files/...` happened: an absolute Peon path joined onto a
// route whose paths are relative to the file transfer sandbox. Overseer maps a
// sandbox path back for us (src/peonFileSandbox.ts); the rule for which route
// answers for which file lives in this module and nowhere else.

export type FileSource =
  // A file in the Peon's file transfer sandbox, named the way a transcript
  // names it: the absolute path for any message the client did not just send,
  // the sandbox-relative upload path for its own optimistic echo.
  | { kind: "attachment"; base: string; path: string }
  | { kind: "project"; base: string; projectKey: string; path: string }
  | { kind: "projectById"; base: string; projectId: string; path: string }
  | { kind: "sessionFile"; base: string; sessionId: string; path: string; raw?: boolean };

export const encodeFilePath = (path: string) => path.split("/").filter(Boolean).map(encodeURIComponent).join("/");

// The API path, for the `api()` helper and for composing a fetch URL.
export function fileApiPath(source: FileSource): string {
  switch (source.kind) {
    case "attachment":
      return `${source.base}/attachments?path=${encodeURIComponent(source.path)}`;
    case "project":
      return `${source.base}/projects/${encodeURIComponent(source.projectKey)}/files/${encodeFilePath(source.path)}`;
    case "projectById":
      return `${source.base}/projects/by-id/${encodeURIComponent(source.projectId)}/files/${encodeFilePath(source.path)}`;
    case "sessionFile":
      return `${source.base}/sessions/${encodeURIComponent(source.sessionId)}/file${source.raw ? "/raw" : ""}?path=${encodeURIComponent(source.path)}`;
  }
}

export const fileUrl = (source: FileSource): string => `/api${fileApiPath(source)}`;

export type FileKind = "image" | "pdf" | "markdown" | "text" | "unsupported";

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i;
const MARKDOWN_EXTENSION = /\.(?:md|markdown|mdown|mkd|mdx)$/i;
const TEXT_EXTENSION = /\.(?:txt|json|ya?ml|csv|log|tsx?|jsx?|css|html?|py|go|rs|java|sh)$/i;

// How a fetched file gets displayed. The Peon's transfer sandbox serves every
// upload as application/octet-stream, so the name and the sender's own
// image/file hint are needed alongside the response type.
// `fallback` is the policy difference between the surfaces: a project tree is
// full of extensionless text (Dockerfile, .gitignore, LICENSE) and shows it,
// while an attachment of an unknown binary type says so rather than rendering
// bytes as characters.
export function fileKind({ name, contentType = "", hint, fallback = "unsupported" }: {
  name: string;
  contentType?: string;
  hint?: "image" | "file";
  fallback?: "text" | "unsupported";
}): FileKind {
  const mime = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (hint === "image" || mime.startsWith("image/") || IMAGE_EXTENSION.test(name)) return "image";
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (MARKDOWN_EXTENSION.test(name)) return "markdown";
  if (mime.startsWith("text/") || TEXT_EXTENSION.test(name)) return "text";
  return fallback;
}

// Where an attachment is written before a message references it. The Peon
// answers with the sandbox-relative path it committed, which is what the
// optimistic echo then shows until the transcript replaces it with the
// absolute one.
export const attachmentUploadPath = (base: string, folder: string, name: string): string =>
  `${base}/files/uploads/${encodeURIComponent(folder)}/${encodeURIComponent(name)}`;

export const fileName = (path: string): string => path.split(/[\\/]/).pop() || path;

export const formatFileSize = (size?: number) => typeof size !== "number" ? ""
  : size < 1024 ? `${size} B`
  : size < 1024 ** 2 ? `${(size / 1024).toFixed(0)} KB`
  : `${(size / 1024 ** 2).toFixed(1)} MB`;
