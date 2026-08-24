import http from "node:http";
import { screenshotDemoEnabled } from "../appReviewDemo.js";
import { demoFileResponse } from "./screenshotDemoFiles.js";

const PORT = 5001;
if (!screenshotDemoEnabled()) {
  throw new Error("refusing App Review demo Peon outside an approved origin");
}

const projects = {
  "demo-peon-orion": [
    {
      projectId: "demo-project-mobile",
      key: "mobile-app",
      name: "Mobile App",
      dir: "/demo/mobile-app",
      metadata: "iOS and Android client",
      sessionCount: 2,
      memberCount: 4,
      activeCount: 0,
    },
    {
      projectId: "demo-project-analytics",
      key: "analytics",
      name: "Product Analytics",
      dir: "/demo/analytics",
      metadata: "Activation and retention insights",
      sessionCount: 1,
      memberCount: 3,
      activeCount: 0,
    },
  ],
  "demo-peon-forge": [
    {
      projectId: "demo-project-storefront",
      key: "storefront",
      name: "Storefront",
      dir: "/demo/storefront",
      metadata: "Customer commerce experience",
      sessionCount: 2,
      memberCount: 5,
      activeCount: 0,
    },
    {
      projectId: "demo-project-release",
      key: "release-automation",
      name: "Release Automation",
      dir: "/demo/release-automation",
      metadata: "Repeatable release checks",
      sessionCount: 1,
      memberCount: 2,
      activeCount: 0,
    },
  ],
  "demo-peon-pixel": [
    {
      projectId: "demo-project-website",
      key: "marketing-site",
      name: "Marketing Site",
      dir: "/demo/marketing-site",
      metadata: "Launch stories and product education",
      sessionCount: 1,
      memberCount: 4,
      activeCount: 0,
    },
    {
      projectId: "demo-project-support",
      key: "customer-support",
      name: "Customer Support",
      dir: "/demo/customer-support",
      metadata: "Customer playbooks and automation",
      sessionCount: 1,
      memberCount: 6,
      activeCount: 0,
    },
  ],
} as const;

const sessions: Record<
  string,
  {
    projectId: string;
    projectKey: string;
    title: string;
    prompt: string;
    answer: string;
  }
> = {
  "demo-session-onboarding": {
    projectId: "demo-project-mobile",
    projectKey: "mobile-app",
    title: "Polish the onboarding experience",
    prompt:
      "Review the new-user journey and suggest the three highest-impact improvements.",
    answer:
      "## Recommended improvements\n\n1. **Start with one clear outcome** — guide new teams to their first successful session.\n2. **Explain agent status in context** — show what is running, queued, or ready.\n3. **Make recovery effortless** — preserve drafts and cached work through connectivity changes.\n\nThe updated journey is shorter, clearer, and measurable.",
  },
  "demo-session-app-store": {
    projectId: "demo-project-mobile",
    projectKey: "mobile-app",
    title: "Prepare the App Store release",
    prompt: "Run the release checklist and prepare launch-ready metadata.",
    answer:
      "Release checks are green. The screenshot story now covers fleet monitoring, projects, sessions, transcripts, and configuration.",
  },
};

function send(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  contentType = "application/json",
): void {
  const payload =
    contentType === "application/json" ? JSON.stringify(body) : String(body);
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function peonId(req: http.IncomingMessage): keyof typeof projects {
  const token = String(req.headers.authorization ?? "");
  if (token.includes("demo-peon-forge")) return "demo-peon-forge";
  if (token.includes("demo-peon-pixel")) return "demo-peon-pixel";
  return "demo-peon-orion";
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://demo");
  if (url.pathname.startsWith("/api/v1/")) {
    url.pathname = url.pathname.slice("/api/v1".length);
  }
  const id = peonId(req);
  const list = projects[id].map((project) => ({
    ...project,
    syncedAt: Date.now(),
  }));
  if (req.method !== "GET")
    return send(res, 405, {
      error: "Demo Peon is read-only",
      code: "DEMO_READ_ONLY",
    });
  if (url.pathname === "/status")
    return send(res, 200, {
      status: "ready",
      agentAuth: { codex: "authenticated", "claude-code": "authenticated" },
    });
  if (url.pathname === "/models")
    return send(res, 200, { providers: [], defaultModel: null });
  if (url.pathname === "/projects") return send(res, 200, { projects: list });

  const projectMatch = url.pathname.match(
    /^\/projects\/by-id\/([^/]+)(?:\/(.*))?$/,
  );
  if (projectMatch) {
    const project = list.find(
      (item) => item.projectId === decodeURIComponent(projectMatch[1]!),
    );
    if (!project) return send(res, 404, { error: "unknown project" });
    const tail = projectMatch[2] ?? "";
    if (!tail) return send(res, 200, project);
    if (tail === "settings")
      return send(res, 200, { ...project, digest: "0".repeat(64) });
    if (tail === "skills")
      return send(res, 200, {
        skills: [
          {
            name: "release-checklist",
            description: "Runs deterministic release readiness checks.",
            path: "skills/release-checklist",
          },
          {
            name: "product-review",
            description:
              "Reviews flows against product goals and accessibility.",
            path: "skills/product-review",
          },
          {
            name: "visual-qa",
            description:
              "Inspects mobile screens for layout and content issues.",
            path: "skills/visual-qa",
          },
        ],
      });
    if (tail === "docs")
      return send(res, 200, {
        exists: true,
        tree: [
          { name: "index.md", type: "file", size: 640, mtimeMs: Date.now() },
          {
            name: "product-brief.md",
            type: "file",
            size: 920,
            mtimeMs: Date.now(),
          },
          {
            name: "release-plan.md",
            type: "file",
            size: 780,
            mtimeMs: Date.now(),
          },
        ],
      });
  }

  const fileMatch = url.pathname.match(/^\/projects\/([^/]+)\/files\/(.*)$/);
  if (fileMatch) {
    const path = decodeURIComponent(fileMatch[2]!);
    // `stat` is the listing request, not `directory`: Overseer strips its own
    // `directory` hint before the request ever reaches a Peon.
    const answer = demoFileResponse(path, url.searchParams.get("stat"));
    if (answer.kind === "stat") return send(res, 200, answer.body);
    return send(res, 200, answer.body, answer.contentType);
  }

  const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)(?:\/(.*))?$/);
  if (sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1]!);
    const session = sessions[sessionId] ?? sessions["demo-session-onboarding"];
    const tail = sessionMatch[2] ?? "";
    if (!tail)
      return send(res, 200, {
        id: sessionId,
        status: "completed",
        projectId: session.projectId,
        projectKey: session.projectKey,
        title: session.title,
        turnCount: 3,
        agent: "codex",
        model: "gpt-5.6",
        reasoningEffort: "high",
        usage: {
          inputTokens: 18420,
          outputTokens: 3260,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 11400,
        },
      });
    if (tail === "transcript") {
      const now = Date.now();
      return send(res, 200, {
        hasMore: false,
        nextCursor: null,
        events: [
          {
            eventId: sessionId + "-user",
            type: "user_message",
            text: session.prompt,
            author: "demo.operator",
            createdAt: now - 180000,
          },
          {
            eventId: sessionId + "-assistant",
            type: "assistant",
            createdAt: now - 120000,
            message: {
              content: [
                {
                  type: "thinking",
                  thinking:
                    "I’ll review the journey, identify friction, and prioritize the changes by customer impact.",
                },
                {
                  type: "tool_use",
                  id: sessionId + "-tool",
                  name: "Read",
                  input: { file_path: "docs/product-brief.md" },
                },
                { type: "text", text: session.answer },
              ],
            },
          },
          {
            eventId: sessionId + "-tool-result",
            type: "user",
            createdAt: now - 110000,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: sessionId + "-tool",
                  content: "Product brief loaded successfully.",
                },
              ],
            },
          },
          {
            eventId: sessionId + "-result",
            type: "result",
            createdAt: now - 60000,
            duration_ms: 121000,
            num_turns: 3,
            total_cost_usd: 0.08,
            usage: { output_tokens: 3260 },
          },
        ],
      });
    }
    if (tail === "inquiries") return send(res, 200, { inquiries: [] });
    if (tail === "queue") return send(res, 200, { items: [] });
  }
  return send(res, 404, { error: "unknown demo endpoint", path: url.pathname });
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`Screenshot demo Peon listening on :${PORT}`),
);
