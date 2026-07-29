// Git helpers used only by source checkouts. Production global installs resolve immutable
// release archives through Overseer instead; see releaseRegistry.ts and cli/update.ts.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// Plain git URL — usable with `git ls-remote`/`git fetch`/`git clone` directly.
export const REPO_GIT_URL = "git@github.com:rnm-dev/overseer.git";

// Resolve the checkout containing packageRoot. Peon lives at apps/peon in the monorepo, so .git
// belongs to an ancestor rather than the package directory itself. A global npm installation has
// no enclosing checkout and therefore returns null.
export function gitCheckoutRoot(packageRoot: string): string | null {
  let candidate = path.resolve(packageRoot);
  for (;;) {
    if (existsSync(path.join(candidate, ".git"))) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

// True when packageRoot belongs to a live git working tree — i.e. peon is running from a source checkout
// (`npm run dev` / `tsx watch`), not from an extracted global `npm install -g`. This is *the*
// discriminator between the two update strategies, because the two installs are shaped
// differently and can't be updated the same way:
//   - a checkout updates via `git fetch` + `git merge --ff-only` (which brings the committed
//     dist/ along with src/), and under `tsx watch` the daemon reloads itself — no npm, no systemd;
//   - a global install updates from an authenticated Overseer release archive + systemd restart.
// A global git install is packed+extracted with no `.git`, so this is false there; a dev checkout
// has `.git`, so it's true. On macOS (no systemd at all) only the checkout path can possibly work.
export function isGitCheckout(packageRoot: string): boolean {
  return gitCheckoutRoot(packageRoot) !== null;
}

// HEAD sha of the checkout at packageRoot, or null if it isn't a git tree / git isn't available.
export function readCheckoutSha(packageRoot: string): string | null {
  const checkoutRoot = gitCheckoutRoot(packageRoot);
  if (!checkoutRoot) return null;
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: checkoutRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

// Source-checkout update status uses the live HEAD. Global update status uses package SemVer and
// therefore never calls this helper.
export function readLocalSha(packageRoot: string): string | null {
  return isGitCheckout(packageRoot) ? readCheckoutSha(packageRoot) : null;
}
