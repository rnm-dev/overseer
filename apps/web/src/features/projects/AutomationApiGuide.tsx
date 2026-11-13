import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useT } from "../../shared/i18n";

// How to call the API (docs/automation-api.md): the base URL and one copyable
// start → follow-up → poll example, filled in with the key just created.

export function automationExample(baseUrl: string, token: string | null): string {
  return [
    `export OVERSEER_TOKEN=${token ?? "<your API key>"}`,
    ``,
    `# Start a session — no project in the body: the token is scoped to this one.`,
    `# The Idempotency-Key is also the request id.`,
    `curl -s ${baseUrl}/sessions \\`,
    `  -H "Authorization: Bearer $OVERSEER_TOKEN" -H "Content-Type: application/json" \\`,
    `  -H "Idempotency-Key: $(uuidgen)" \\`,
    `  -d '{"prompt":"Triage the new ticket","correlationId":"ticket-42"}'`,
    `# → { "sessionId": "…", "requestId": "…", … }`,
    ``,
    `# Send a follow-up into it (returns its own requestId)`,
    `curl -s ${baseUrl}/sessions/$SESSION_ID/followup \\`,
    `  -H "Authorization: Bearer $OVERSEER_TOKEN" -H "Content-Type: application/json" \\`,
    `  -H "Idempotency-Key: $(uuidgen)" -d '{"prompt":"Also check the logs"}'`,
    ``,
    `# Poll one request until "done": true`,
    `curl -s ${baseUrl}/sessions/$SESSION_ID/requests/$REQUEST_ID \\`,
    `  -H "Authorization: Bearer $OVERSEER_TOKEN"`,
    `# → { "status": "queued|running|completed|failed", "done": …, "text": "…", "awaitingSignoff": … }`,
  ].join("\n");
}

export function AutomationApiGuide({ token }: { token: string | null }) {
  const t = useT();
  const baseUrl = `${window.location.origin}/api/automation/v1`;
  const example = automationExample(baseUrl, token);
  const [copied, setCopied] = useState<"base" | "example" | null>(null);
  const copy = (what: "base" | "example", text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(what);
      window.setTimeout(() => setCopied(null), 1500);
    });
  };
  const CopyIcon = ({ what }: { what: "base" | "example" }) => copied === what ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />;

  return (
    <div className="space-y-3">
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded border border-edge bg-surface/60 px-2 py-1.5 font-mono text-[0.68rem] text-ink">{baseUrl}</code>
          <button type="button" className="btn-ghost btn-sm" title={t("proj.api.copy")} aria-label={t("proj.api.copy")} onClick={() => copy("base", baseUrl)}>
            <CopyIcon what="base" />
          </button>
        </div>
        <div className="relative">
          <pre className="max-h-72 overflow-auto rounded border border-edge bg-surface/60 p-2 pr-9 font-mono text-[0.65rem] leading-relaxed text-ink">{example}</pre>
          <button type="button" className="btn-ghost btn-sm absolute right-1 top-1" title={t("proj.api.copy")} aria-label={t("proj.api.copy")} onClick={() => copy("example", example)}>
            <CopyIcon what="example" />
          </button>
        </div>
        <a className="inline-block text-[0.68rem] text-ink-muted hover:text-accent-strong" href={`${baseUrl}/openapi.json`} target="_blank" rel="noreferrer">
          {t("proj.api.openapi")}
        </a>
    </div>
  );
}
