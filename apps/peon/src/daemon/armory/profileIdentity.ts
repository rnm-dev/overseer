// A profile's stored values are write-only, and nothing derived from them may
// become a credential oracle. One thing an operator still needs back is the
// public identity the credential acts as: a Google service account is useless
// until its address is pasted into a Drive folder, a Sheet or an IAM binding.
//
// `client_email` in a service account key file is exactly that address — an
// identifier Google expects to be shared, never secret material. It is derived
// here from a well-formed key file only, and nothing else in the file is ever
// exposed. A type with no declared identity has none; absence is not an error.

import type { ArmoryProfileIdentity } from "./contracts.js";

const MAX_IDENTITY_VALUE_LENGTH = 320;
const MAX_IDENTITY_SOURCE_LENGTH = 256 * 1024;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$/;

export const GOOGLE_SERVICE_ACCOUNT_PROFILE_TYPE = "google-service-account";

export function armoryProfileIdentity(type: string, values: Record<string, string>): ArmoryProfileIdentity | null {
  if (type !== GOOGLE_SERVICE_ACCOUNT_PROFILE_TYPE) return null;
  for (const field of Object.keys(values).sort()) {
    const email = serviceAccountEmail(values[field]);
    if (email) return { label: "Service account email", value: email };
  }
  return null;
}

function serviceAccountEmail(raw: string | undefined): string | null {
  if (!raw || raw.length > MAX_IDENTITY_SOURCE_LENGTH || !raw.trimStart().startsWith("{")) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const email = (parsed as Record<string, unknown>).client_email;
  if (typeof email !== "string" || email.length > MAX_IDENTITY_VALUE_LENGTH || !EMAIL.test(email)) return null;
  return email;
}
