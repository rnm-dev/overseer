import pg from "pg";

const WORKSPACE_ID = "demo-screenshot-workspace";
const PEONS = [
  ["demo-peon-orion", "demo-credential-orion", "Orion"],
  ["demo-peon-forge", "demo-credential-forge", "Forge"],
  ["demo-peon-pixel", "demo-credential-pixel", "Pixel"],
] as const;
const PROJECTS = [
  [
    "demo-project-mobile",
    PEONS[0][0],
    "mobile-app",
    "Mobile App",
    "# Mobile App\n\nA polished companion app for teams coordinating AI-assisted work.\n\n## Current focus\n\n- Faster onboarding\n- Accessible navigation\n- Reliable offline workflows\n- App Store launch readiness",
  ],
  [
    "demo-project-analytics",
    PEONS[0][0],
    "analytics",
    "Product Analytics",
    "# Product Analytics\n\nTrusted product insights for the Northstar team.\n\n## Dashboards\n\n- Activation\n- Retention\n- Feature adoption",
  ],
  [
    "demo-project-storefront",
    PEONS[1][0],
    "storefront",
    "Storefront",
    "# Storefront\n\nThe customer-facing commerce experience.\n\n## Quality bar\n\nFast, accessible, resilient, and easy to understand.",
  ],
  [
    "demo-project-release",
    PEONS[1][0],
    "release-automation",
    "Release Automation",
    "# Release Automation\n\nRepeatable checks and releases across mobile and web products.",
  ],
  [
    "demo-project-website",
    PEONS[2][0],
    "marketing-site",
    "Marketing Site",
    "# Marketing Site\n\nClear product storytelling, launch notes, and customer education.",
  ],
  [
    "demo-project-support",
    PEONS[2][0],
    "customer-support",
    "Customer Support",
    "# Customer Support\n\nPlaybooks and automation that help every customer get a thoughtful answer.",
  ],
] as const;
const SESSIONS = [
  [
    "demo-session-onboarding",
    PROJECTS[0][0],
    "Polish the onboarding experience",
    "Review the new-user journey and suggest the three highest-impact improvements.",
    "Mapped the complete journey and prepared three focused improvements with clear acceptance criteria.",
    8,
  ],
  [
    "demo-session-app-store",
    PROJECTS[0][0],
    "Prepare the App Store release",
    "Run the release checklist and prepare launch-ready metadata.",
    "Release checks are green. Metadata, screenshots, and reviewer notes are ready for final approval.",
    24,
  ],
  [
    "demo-session-activation",
    PROJECTS[1][0],
    "Analyze weekly activation",
    "Find the strongest activation signal from this week's product data.",
    "Teams that create a second project in their first week show the strongest improvement in retention.",
    47,
  ],
  [
    "demo-session-checkout",
    PROJECTS[2][0],
    "Improve checkout performance",
    "Profile checkout and remove the largest avoidable delay.",
    "Reduced the critical request chain and added regression coverage for the optimized path.",
    73,
  ],
  [
    "demo-session-accessibility",
    PROJECTS[2][0],
    "Audit storefront accessibility",
    "Audit the purchase flow for keyboard, contrast, and screen-reader issues.",
    "Completed the audit and grouped the findings by customer impact and implementation effort.",
    112,
  ],
  [
    "demo-session-release",
    PROJECTS[3][0],
    "Automate release verification",
    "Turn the manual release checklist into a repeatable verification command.",
    "Added deterministic preflight checks and a concise release report for operators.",
    156,
  ],
  [
    "demo-session-launch",
    PROJECTS[4][0],
    "Draft the launch story",
    "Create a concise launch narrative focused on customer outcomes.",
    "Prepared a clear launch story with benefits, proof points, and a focused call to action.",
    205,
  ],
  [
    "demo-session-help",
    PROJECTS[5][0],
    "Refresh the help center",
    "Identify gaps in the getting-started documentation and propose fixes.",
    "Reorganized the guide around the first successful workflow and added troubleshooting paths.",
    288,
  ],
] as const;

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : "";
  if (!value)
    throw new Error("usage: seed:screenshot-demo --owner-email <email>");
  return value;
}

function developmentDatabaseUrl(): string {
  if (process.env.NODE_ENV !== "development")
    throw new Error("refusing demo seed: NODE_ENV must equal development");
  if (process.env.OVERSEER_PUBLIC_URL !== "https://overseer-dev.rnm.dev") {
    throw new Error(
      "refusing demo seed: OVERSEER_PUBLIC_URL must be https://overseer-dev.rnm.dev",
    );
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  return process.env.DATABASE_URL;
}

async function main(): Promise<void> {
  const email = argument("--owner-email");
  const pool = new pg.Pool({ connectionString: developmentDatabaseUrl() });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ id: string }>(
      "SELECT id FROM users WHERE LOWER(email)=LOWER($1)",
      [email],
    );
    const userId = result.rows[0]?.id;
    if (!userId)
      throw new Error(
        "sign in to the development Overseer before seeding: " + email,
      );
    const now = Date.now();
    await client.query(
      "INSERT INTO workspaces (id,name,slug,created_by,created_at) VALUES ($1,'Northstar Demo','northstar-demo',$2,$3) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,slug=EXCLUDED.slug,created_by=EXCLUDED.created_by",
      [WORKSPACE_ID, userId, now],
    );
    await client.query(
      "INSERT INTO workspace_members (workspace_id,user_id,role,added_at,joined_via) VALUES ($1,$2,'owner',$3,'creator') ON CONFLICT (workspace_id,user_id) DO UPDATE SET role='owner',joined_via='creator'",
      [WORKSPACE_ID, userId, now],
    );

    for (const [peonId, credentialId, name] of PEONS) {
      const token = "demo-only-" + peonId;
      await client.query(
        "INSERT INTO peon_credentials (id,workspace_id,token,label,created_by,created_at,bound_peon_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,label=EXCLUDED.label,bound_peon_id=EXCLUDED.bound_peon_id",
        [credentialId, WORKSPACE_ID, token, name, userId, now, peonId],
      );
      await client.query(
        "INSERT INTO peons (peon_id,credential_id,workspace_id,name,hostname,address,control_port,protocol,capabilities,load,token,registered_at,last_seen) VALUES ($1,$2,$3,$4,$5,'127.0.0.1',5001,1,'[\"transcript-pagination-v1\"]'::jsonb,$6::jsonb,$7,$8,$8) ON CONFLICT (peon_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,name=EXCLUDED.name,hostname=EXCLUDED.hostname,address='127.0.0.1',control_port=5001,protocol=1,capabilities='[\"transcript-pagination-v1\"]'::jsonb,load=EXCLUDED.load,last_seen=EXCLUDED.last_seen",
        [
          peonId,
          credentialId,
          WORKSPACE_ID,
          name,
          name.toLowerCase() + ".demo.internal",
          JSON.stringify({ running: 0, queued: 0 }),
          token,
          now,
        ],
      );
      await client.query(
        "INSERT INTO peon_project_sync (peon_id,catalog_epoch,acknowledged_seq,status,updated_at,generation) VALUES ($1,'demo-projects-v1',1,'ready',$2,'demo-seed') ON CONFLICT (peon_id) DO UPDATE SET catalog_epoch='demo-projects-v1',acknowledged_seq=1,status='ready',updated_at=EXCLUDED.updated_at",
        [peonId, now],
      );
      await client.query(
        "INSERT INTO peon_session_sync (peon_id,status,updated_at,generation,catalog_epoch,acknowledged_seq) VALUES ($1,'ready',$2,'demo-seed','demo-sessions-v1',1) ON CONFLICT (peon_id) DO UPDATE SET status='ready',updated_at=EXCLUDED.updated_at,catalog_epoch='demo-sessions-v1',acknowledged_seq=1",
        [peonId, now],
      );
    }

    for (const [projectId, peonId, key, name, docs] of PROJECTS) {
      await client.query(
        "INSERT INTO projects (peon_id,project_id,project_key,name,dir,metadata,docs_index,quick_links,synced_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'[]'::jsonb,$8) ON CONFLICT (peon_id,project_id) DO UPDATE SET project_key=EXCLUDED.project_key,name=EXCLUDED.name,dir=EXCLUDED.dir,metadata=EXCLUDED.metadata,docs_index=EXCLUDED.docs_index,synced_at=EXCLUDED.synced_at",
        [
          peonId,
          projectId,
          key,
          name,
          "/demo/" + key,
          "Fictional App Store screenshot project",
          docs,
          now,
        ],
      );
    }

    for (const [index, session] of SESSIONS.entries()) {
      const [sessionId, projectId, title, prompt, preview, ageMinutes] =
        session;
      const project = PROJECTS.find((item) => item[0] === projectId);
      if (!project) throw new Error("unknown demo project " + projectId);
      const [_, peonId, projectKey] = project;
      const activity = now - ageMinutes * 60_000;
      await client.query(
        "INSERT INTO sessions (peon_id,session_id,status,project_key,project_id,title,prompt_preview,preview,author,outcome,started_at,ended_at,last_activity_at,raw,synced_at) VALUES ($1,$2,'completed',$3,$4,$5,$6,$7,'demo.operator@example.com',$8::jsonb,$9,$10,$10,$11::jsonb,$12) ON CONFLICT (peon_id,session_id) DO UPDATE SET status='completed',project_key=EXCLUDED.project_key,project_id=EXCLUDED.project_id,title=EXCLUDED.title,prompt_preview=EXCLUDED.prompt_preview,preview=EXCLUDED.preview,outcome=EXCLUDED.outcome,last_activity_at=EXCLUDED.last_activity_at,raw=EXCLUDED.raw,synced_at=EXCLUDED.synced_at",
        [
          peonId,
          sessionId,
          projectKey,
          projectId,
          title,
          prompt,
          preview,
          JSON.stringify({ status: "success", summary: preview }),
          activity - 240_000,
          activity,
          JSON.stringify({
            id: sessionId,
            promptPreview: prompt,
            lastMessagePreview: preview,
          }),
          now + index,
        ],
      );
      await client.query(
        "INSERT INTO session_attention (workspace_id,user_id,peon_id,session_id,occurrence_key,state,requested_at,completed_at,read_at,resolved_at) VALUES ($1,$2,$3,$4,'demo-seed','read',$5,$6,$6,$6) ON CONFLICT (user_id,peon_id,session_id,occurrence_key) DO UPDATE SET state='read',requested_at=EXCLUDED.requested_at,completed_at=EXCLUDED.completed_at,read_at=EXCLUDED.read_at,resolved_at=EXCLUDED.resolved_at",
        [WORKSPACE_ID, userId, peonId, sessionId, activity - 240_000, activity],
      );
    }

    await client.query("COMMIT");
    console.log(
      "Seeded Northstar Demo for " +
        email +
        ": 3 Peons, 6 projects, 8 sessions.",
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
