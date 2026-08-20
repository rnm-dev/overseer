import { getInvitePreview } from "../workspaces/index.js";

/**
 * May an identity with no account here become one?
 *
 * Only with an invitation. Possession of the token is the capability, the same
 * rule that already governs joining a workspace — and an account that arrived
 * without one could do nothing anyway, since it would belong to no workspace.
 * Open registration was therefore never a feature, only a way to fill the users
 * table with rows nobody can use.
 *
 * The first account is not a special case for this to solve: `overseer admin
 * bootstrap` prints an invitation from a shell, where having one is the
 * authority.
 *
 * OIDC never asks. A configured single-tenant issuer is itself the invitation —
 * the instance named that directory, `iss` is compared byte for byte, and an
 * administrator there decided this person has an account. Gating it would also
 * make the directory's own workspace impossible, where the first arrival is
 * supposed to bring it into being.
 */
export async function mayCreateAccount(inviteToken: unknown): Promise<boolean> {
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
