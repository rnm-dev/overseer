import { config } from "../../infrastructure/config/index.js";
import { getInvitePreview } from "../workspaces/index.js";

/**
 * May an identity with no account here become one?
 *
 * By default only with an invitation. Possession of the token is the capability,
 * the same rule that already governs joining a workspace, and it is the right
 * default for the instance this product is usually deployed as: one operator's,
 * or one team's, reachable from the public internet.
 *
 * `OVERSEER_OPEN_SIGNUP=1` says the opposite out loud — anyone who can reach
 * this instance may have an account on it. What they get is a personal
 * workspace and nothing else: `ensureDefaultWorkspace` runs for every new
 * account whichever door it came through, and no existing workspace becomes
 * reachable without an invitation to it. So the switch decides who may hold an
 * account here, never what an account already reaches.
 *
 * The first account is what makes the choice unavoidable, and this is where an
 * instance answers it. There is no shell command that admits an operator behind
 * the rule any more: an instance either opens registration long enough for its
 * first account, or it names an OIDC directory that admits one. Either way the
 * arrival gets a workspace of their own and the instance can be closed again on
 * the next request.
 *
 * OIDC never asks. A configured single-tenant issuer is itself the invitation —
 * the instance named that directory, `iss` is compared byte for byte, and an
 * administrator there decided this person has an account. Gating it would also
 * make the directory's own workspace impossible, where the first arrival is
 * supposed to bring it into being.
 */
export async function mayCreateAccount(inviteToken: unknown): Promise<boolean> {
  // Read per call, not captured at import: the tests — and a future reload —
  // change the instance's mind about this between one registration and the next.
  if (config.auth.openSignup) return true;
  const token = typeof inviteToken === "string" ? inviteToken.trim() : "";
  if (!token) return false;
  // Only checked here, and redeemed later by whoever created the account: a
  // token that turns out to be spent between the two leaves an account with no
  // workspace rather than no account, which is the recoverable direction.
  return (await getInvitePreview(token)) !== null;
}

export const SIGNUP_CLOSED = {
  code: "SIGNUP_CLOSED",
  message: "an invitation is required to create an account here",
} as const;
