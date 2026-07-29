import { readFileSync } from "node:fs";

// Env → resolved push settings. Pure in the same sense as voiceConfig: the
// environment (and the file reader, so a path can be exercised without touching
// the disk) arrives as an argument, so precedence is testable and config.ts owns
// the wiring without infrastructure depending back on it.
//
//   OVERSEER_PUSH_FCM_CREDENTIALS   a Firebase service account, given as
//                                   raw JSON, base64 of that JSON, or a path
//
// Expo needs no credential — exp.host authenticates the token itself — so an
// instance with nothing set here still delivers to Expo subscriptions. FCM is
// the addition: it is the direct path to Android/iOS tokens minted by the
// Firebase SDK, and it only exists when a service account is configured.

export interface FcmServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

export interface PushConfig {
  fcm: FcmServiceAccount | null;
  warnings: string[];
}

interface ServiceAccountJson {
  type?: unknown;
  project_id?: unknown;
  client_email?: unknown;
  private_key?: unknown;
  token_uri?: unknown;
}

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

// The three accepted encodings are distinguished by their first character, not
// by guessing: `{` is the JSON itself, a leading path separator (or `~`) is a
// file to read, and anything else is base64. Deploys carry the credential as
// base64 because a Docker env file is line-oriented and a service account key
// is not.
function credentialText(raw: string, readFile: (path: string) => string): string {
  if (raw.startsWith("{")) return raw;
  if (raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("~")) return readFile(raw);
  return Buffer.from(raw, "base64").toString("utf8");
}

function parseServiceAccount(raw: string, readFile: (path: string) => string): { account: FcmServiceAccount | null; warning: string | null } {
  let parsed: ServiceAccountJson;
  try {
    parsed = JSON.parse(credentialText(raw, readFile)) as ServiceAccountJson;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { account: null, warning: `OVERSEER_PUSH_FCM_CREDENTIALS could not be read as a service account (${reason}) — FCM push is disabled.` };
  }
  const projectId = typeof parsed.project_id === "string" ? parsed.project_id.trim() : "";
  const clientEmail = typeof parsed.client_email === "string" ? parsed.client_email.trim() : "";
  // A key pasted through a shell or a .env editor often arrives with its
  // newlines escaped. Restore them, or every signature fails at runtime with an
  // opaque OpenSSL error.
  const privateKey = typeof parsed.private_key === "string" ? parsed.private_key.replace(/\\n/g, "\n").trim() : "";
  if (!projectId || !clientEmail || !privateKey) {
    return { account: null, warning: "OVERSEER_PUSH_FCM_CREDENTIALS is missing project_id, client_email or private_key — FCM push is disabled." };
  }
  const tokenUri = typeof parsed.token_uri === "string" && parsed.token_uri.trim() ? parsed.token_uri.trim() : DEFAULT_TOKEN_URI;
  return { account: { projectId, clientEmail, privateKey, tokenUri }, warning: null };
}

export function resolvePushConfig(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): PushConfig {
  const raw = (env.OVERSEER_PUSH_FCM_CREDENTIALS ?? "").trim();
  if (!raw) return { fcm: null, warnings: [] };
  const { account, warning } = parseServiceAccount(raw, readFile);
  return { fcm: account, warnings: warning ? [warning] : [] };
}
