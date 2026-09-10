// Every file this app shows — a message attachment, a project file, a docs
// page, a session artifact — is named by one of these sources, and every URL
// that reads one is built here. A surface that assembles its own path is how
// `/files//tmp/peon-files/...` happened: an absolute Peon path joined onto a
// route whose paths are relative to the file transfer sandbox. Overseer maps a
// sandbox path back for us (src/infrastructure/peonHttp/peonFileSandbox.ts); the rule for which route
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

// The project tree has already classified this target as a directory. Mark
// that fact explicitly so Overseer can select the folder socket without first
// probing it for an individual-file metadata request.
export const projectDirectoryListingPath = (filesBase: string, path: string): string =>
  `${filesBase}/${encodeFilePath(path)}?stat=1&directory=1`;

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

// Where a surface may write the file back. Only the project routes take a PUT
// of a path relative to a base, which is what the editor uploads to; an
// attachment or a session artifact is read-only here, so a surface showing one
// is never offered an editor rather than offering one that cannot save.
export function fileWriteBase(source: FileSource): string | null {
  switch (source.kind) {
    case "project":
      return `${source.base}/projects/${encodeURIComponent(source.projectKey)}/files`;
    case "projectById":
      return `${source.base}/projects/by-id/${encodeURIComponent(source.projectId)}/files`;
    case "attachment":
    case "sessionFile":
      return null;
  }
}

// Saving a file always wants its bytes; the session-file route answers with
// metadata unless the raw body is asked for by name.
export const fileDownloadUrl = (source: FileSource): string =>
  fileUrl(source.kind === "sessionFile" ? { ...source, raw: true } : source);

export type FileKind = "image" | "pdf" | "markdown" | "html" | "text" | "unsupported";

// Whether a page fetched from this route arrives as a page. Only the project
// routes type their bytes from the name (Peon answers them with `sendFile`):
// the file transfer sandbox serves every attachment as
// application/octet-stream, and a session artifact allows inline images and
// PDFs and nothing else, both deliberately. A frame pointed at those downloads
// the file instead of rendering it, so they keep showing their markup.
export const rendersHtmlInline = (source: FileSource): boolean =>
  source.kind === "project" || source.kind === "projectById";

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i;
const MARKDOWN_EXTENSION = /\.(?:md|markdown|mdown|mkd|mdx)$/i;
const HTML_EXTENSION = /\.(?:html?|xhtml)$/i;
const TEXT_EXTENSION = /\.(?:txt|json|ya?ml|csv|log|tsx?|jsx?|css|html?|py|go|rs|java|sh)$/i;

// Formats this app has no rendering for and never will: archives, installers,
// executables, compiled artifacts, fonts, media containers, office documents.
// They are named separately from the `fallback` policy because a project tree
// asks for `fallback: "text"` — correct for Dockerfile and LICENSE, and how a
// zip came to be pulled in full and painted on screen as a wall of mojibake.
const BINARY_EXTENSION = /\.(?:zip|tar|t[gbx]z|gz|bz2|xz|zst|7z|rar|lz4?|jar|war|ear|iso|dmg|pkg|deb|rpm|apk|aab|msi|exe|dll|so|dylib|bin|obj|class|wasm|pyc|pyd|node|woff2?|ttf|otf|eot|mp3|wav|flac|ogg|oga|opus|m4a|aac|mp4|m4v|mov|avi|mkv|webm|wmv|psd|ai|sketch|fig|blend|docx?|xlsx?|pptx?|od[tsp]|rtf|sqlite3?|db-wal|pdb|pack|idx)$/i;
const BINARY_MIME = /^(?:audio|video|font|model)\/|^application\/(?:zip|gzip|x-(?:tar|gzip|bzip2?|xz|7z-compressed|rar-compressed|zip-compressed|msdownload|sharedlib|executable|font-\w+)|java-archive|wasm|vnd\.(?:openxmlformats-officedocument|ms-(?:excel|word|powerpoint)|oasis\.opendocument|android\.package-archive|debian\.binary-package|rar|sqlite3))/;

// Whether a file can be refused on sight. `application/octet-stream` is
// deliberately absent: the Peon's transfer sandbox serves every upload that
// way, so it says nothing about the bytes.
export function isUnviewableFile(name: string, contentType = ""): boolean {
  const mime = contentType.split(";", 1)[0]!.trim().toLowerCase();
  return BINARY_EXTENSION.test(name) || (!!mime && BINARY_MIME.test(mime));
}

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
  // A page is shown as the page, not as its markup: the renderer frames it and
  // keeps the source one click away. The name decides, because the Peon's
  // transfer sandbox serves an upload as application/octet-stream.
  if (HTML_EXTENSION.test(name) || mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (isUnviewableFile(name, contentType)) return "unsupported";
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
