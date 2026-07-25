// The API creates this URL from the callback stored with the OAuth attempt.
// That callback was already matched exactly against the server-side allowlist
// when the native flow started. Keep that allowlist server-owned so dev and
// production app schemes cannot drift from a second frontend copy.
export function serverApprovedNativeRedirect(redirectUrl: string): string {
  return new URL(redirectUrl).toString();
}
