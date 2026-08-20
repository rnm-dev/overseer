import { config } from "../../infrastructure/config/index.js";
import { getInvitePreview } from "../workspaces/index.js";

/**
 * May an identity with no account here become one?
 *
 * `OVERSEER_SIGNUP=invite` closes the doors that have no directory behind them.
 * An invitation reopens them for one person: possession of the token is the
 * capability, the same rule that already governs joining a workspace.
 *
 * OIDC never asks. A configured single-tenant issuer is itself the invitation —
 * the instance named that directory, `iss` is compared byte for byte, and an
 * administrator there decided this person has an account. Gating it would also
 * make `OVERSEER_OIDC_PROVISION_WORKSPACE` impossible, where the first arrival
 * is supposed to bring the workspace into being.
 */
export async function mayCreateAccount(inviteToken: unknown): Promise<boolean> {
  if (config.auth.signup === "open") return true;
  const token = typeof inviteToken === "string" ? inviteToken.trim() : "";
  if (!token) return false;
  // Only checked here, and redeemed later by whoever created the account: a
  // token that turns out to be spent between the two leaves an account with no
  // workspace rather than no account, which is the recoverable direction.
  return (await getInvitePreview(token)) !== null;
}

export const SIGNUP_CLOSED = {
  code: "SIGNUP_CLOSED",
  message: "this instance only accepts invited accounts",
} as const;
