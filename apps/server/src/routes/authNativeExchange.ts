import express from "express";
import { exchangeNativeAppCode, nativeAppCodeProvider } from "../modules/auth/index.js";
import { limited, methodStillOpen, tooManyAttempts } from "./authMethodAccess.js";
import { clientInfo } from "./requestContext.js";

// Where every native sign-in ends: a one-time app code, handed to the app on a
// deep link, redeemed here for the device token it stands for.
//
// This is deliberately not a per-provider route. An app code stands for a
// sign-in that has *already happened*, and the door it came through is recorded
// on the code — so the caller does not get to name it, and there is nothing for
// a second copy of this route to decide differently. Email + password reaches
// this same exchange, which is why it lives here rather than inside the
// redirect-provider template.
//
// The invariant that switching a method off closes flows already in the air
// still holds, and holds harder: the door is resolved from the code, then *that*
// door's guard is what refuses. Naming another provider in the path cannot move
// a code out from under its own guard.

function badAppCode(res: express.Response): express.Response {
  return res.status(400).json({ error: "invalid, expired, or already used app code", code: "BAD_APP_CODE" });
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function exchange(req: express.Request, res: express.Response): Promise<express.Response | undefined> {
  if (limited(req, "native-exchange", 20)) return tooManyAttempts(res, "exchange attempts");
  const state = text(req.body?.state);
  const code = text(req.body?.code);
  if (!state || !code) return res.status(400).json({ error: "code and state are required", code: "BAD_REQUEST" });

  // Resolved before anything is spent, so the refusal for a disabled method is
  // that method's own 503 rather than a code silently consumed and denied.
  const provider = await nativeAppCodeProvider(state, code);
  if (!provider) return badAppCode(res);
  if (!methodStillOpen(res, provider)) return;

  // A code that passed the lookup can still lose the race to redeem it: the
  // delete is atomic, so the loser is told the code is spent, which it is.
  const redeemed = await exchangeNativeAppCode(state, code, provider, clientInfo(req));
  if (!redeemed) return badAppCode(res);
  return res.json({
    token: redeemed.token,
    user: { email: redeemed.user.email, githubLogin: redeemed.user.githubLogin, avatarUrl: redeemed.user.avatarUrl },
    device: redeemed.device,
  });
}

/**
 * Mount the exchange, plus the two paths that used to own a copy of it.
 *
 * `/auth/github/native/exchange` and `/auth/oidc/native/exchange` are kept
 * because clients are already shipped against them — an installed app cannot be
 * asked to update before its next sign-in works. They are aliases, not
 * variants: each resolves the door from the code exactly as the neutral path
 * does, which is what lets a build that only knows the GitHub path finish a
 * password sign-in on an instance where GitHub is switched off.
 */
export function mountNativeExchange(router: express.Router): void {
  for (const path of ["/auth/native/exchange", "/auth/github/native/exchange", "/auth/oidc/native/exchange"]) {
    router.post(path, exchange);
  }
}
