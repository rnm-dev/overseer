import { config } from "../infrastructure/config/index.js";
import { query } from "../infrastructure/db/index.js";
import {
  createInvite,
  createUnclaimedWorkspace,
  updateMemberRole,
} from "../modules/workspaces/index.js";
import type { Role } from "../modules/workspaces/index.js";

/**
 * Instance administration from a shell on the host.
 *
 * The authority here is being able to run a command inside the container, which
 * is the right one for the things this does: standing an instance up before any
 * account exists, and repairing the one state the product cannot fix from
 * inside itself — a workspace whose last owner is gone. It adds no network
 * surface and nothing new to authenticate.
 *
 * Everything below is glue over the same functions the HTTP routes use. It
 * deliberately cannot do more than an owner could: no reading of sessions, no
 * impersonation, no minting of device tokens.
 */

const USAGE = `overseer admin <command>

  bootstrap <name>            create a workspace and print a one-time owner link
  invite <slug> [--member]    print a join link for an existing workspace (owner by default)
  users                       list accounts and the doors they came through
  promote <email> [slug]      make an existing account an owner
  demote <email> [slug]       make an owner an ordinary member

Run inside the container, where DATABASE_URL is already set. The image ships the
compiled entry point at /app/dist/index.js and puts nothing on PATH:
  docker compose exec app node dist/index.js admin bootstrap "Acme"`;

function joinUrl(token: string): string {
  return `${config.publicUrl.replace(/\/+$/, "")}/join/${token}`;
}

async function workspaceBySlug(slug: string): Promise<{ id: string; name: string } | null> {
  const { rows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM workspaces WHERE slug = $1`,
    [slug],
  );
  return rows[0] ?? null;
}

async function userByEmail(email: string): Promise<{ id: string; email: string } | null> {
  const { rows } = await query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  return rows[0] ?? null;
}

// The workspace a command means when it names none: only unambiguous when there
// is exactly one, because silently picking the oldest would put somebody in a
// workspace they did not name.
async function soleWorkspace(): Promise<{ id: string; name: string } | null> {
  const { rows } = await query<{ id: string; name: string }>(`SELECT id, name FROM workspaces LIMIT 2`);
  return rows.length === 1 ? rows[0]! : null;
}

async function resolveWorkspace(slug: string | undefined): Promise<{ id: string; name: string }> {
  if (slug) {
    const found = await workspaceBySlug(slug);
    if (!found) throw new Error(`no workspace with slug "${slug}"`);
    return found;
  }
  const only = await soleWorkspace();
  if (!only) throw new Error("name the workspace by slug — this instance has none, or more than one");
  return only;
}

async function bootstrap(name: string | undefined): Promise<void> {
  if (!name) throw new Error('bootstrap needs a name: admin bootstrap "Acme"');
  const workspace = await createUnclaimedWorkspace(name);
  const invite = await createInvite(workspace.id, "owner", null, "bootstrap");
  console.log(`created workspace "${workspace.name}" (${workspace.slug})`);
  console.log(`owner link, good for 7 days and one use:\n\n  ${joinUrl(invite.token)}\n`);
  console.log("Open it in a browser and sign in — the account that redeems it owns the workspace.");
}

async function invite(slug: string | undefined, role: Role): Promise<void> {
  const workspace = await resolveWorkspace(slug);
  const created = await createInvite(workspace.id, role, null, "admin cli");
  console.log(`${role} link for "${workspace.name}", good for 7 days and one use:\n\n  ${joinUrl(created.token)}`);
}

async function users(): Promise<void> {
  const { rows } = await query<{
    email: string;
    doors: string;
    workspaces: string | null;
  }>(
    `SELECT u.email,
            concat_ws(' ',
              CASE WHEN u.password_hash IS NOT NULL THEN 'password' END,
              CASE WHEN u.github_id     IS NOT NULL THEN 'github'   END,
              CASE WHEN u.oidc_subject  IS NOT NULL THEN 'oidc'     END) AS doors,
            (SELECT string_agg(w.slug || ':' || m.role, ' ' ORDER BY w.slug)
               FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
              WHERE m.user_id = u.id) AS workspaces
       FROM users u ORDER BY u.created_at ASC`,
  );
  if (rows.length === 0) {
    console.log("no accounts yet — `admin bootstrap <name>` prints a link to make the first one");
    return;
  }
  for (const r of rows) {
    console.log(`${r.email}\t${r.doors || "no door"}\t${r.workspaces ?? "no workspace"}`);
  }
}

async function setRole(email: string | undefined, slug: string | undefined, role: Role): Promise<void> {
  if (!email) throw new Error(`${role === "owner" ? "promote" : "demote"} needs an email address`);
  const user = await userByEmail(email);
  if (!user) throw new Error(`no account for ${email}`);
  const workspace = await resolveWorkspace(slug);
  const result = await updateMemberRole(workspace.id, user.id, role);
  if (result === "not_found") throw new Error(`${user.email} is not a member of "${workspace.name}"`);
  // The product's own rule, not a CLI limitation: a workspace that loses its
  // last owner cannot be administered by anybody, so the demotion is refused
  // here exactly as it is over HTTP.
  if (result === "last_owner") throw new Error(`${user.email} is the last owner of "${workspace.name}" — promote someone else first`);
  console.log(`${user.email} is now ${role} of "${workspace.name}"`);
}

export async function runAdmin(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const args = rest.filter((a) => !a.startsWith("--"));
  try {
    switch (command) {
      case "bootstrap":
        await bootstrap(args[0]);
        return 0;
      case "invite":
        await invite(args[0], flags.has("--member") ? "member" : "owner");
        return 0;
      case "users":
        await users();
        return 0;
      case "promote":
        await setRole(args[0], args[1], "owner");
        return 0;
      case "demote":
        await setRole(args[0], args[1], "member");
        return 0;
      default:
        console.log(USAGE);
        return command ? 1 : 0;
    }
  } catch (err) {
    console.error(`overseer admin: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
