import { PROJECT_DOCS_INDEX, readProjectDoc } from "../projects/index.js";
export const OUTCOME_SCHEMA = {
    type: "object",
    properties: {
        result: { type: "string", enum: ["success", "failure", "needs_human"] },
        summary: { type: "string" },
        previewPath: { type: "string" },
    },
    required: ["result", "summary"],
    additionalProperties: false,
};
// OpenAI strict structured outputs require every property of every object to
// appear in `required`. A value that is optional in Peon's semantic contract
// must therefore be represented as required-but-nullable for Codex. Keep the
// Claude schema above stable: Claude accepts omitted optional properties and
// does not need the stricter provider-specific representation.
export const CODEX_OUTCOME_SCHEMA = {
    type: "object",
    properties: {
        result: { type: "string", enum: ["success", "failure", "needs_human"] },
        summary: { type: "string" },
        previewPath: { type: ["string", "null"] },
    },
    required: ["result", "summary", "previewPath"],
    additionalProperties: false,
};
const BASE_SYSTEM_PROMPT = `You are running inside an unattended, non-interactive harness. There is no human available to
answer follow-up questions during this run — do your best with the information given, or
explicitly report what's blocking you.

If you hit what looks like a hard environment/permission wall (a command is refused, a tool is
unavailable, access is denied), try at most one or two alternative approaches — then stop and
report the failure with the exact error you saw. Do not keep probing, retrying, or searching for
workarounds; there is a fixed turn budget for this run, and a fast, clear failure is far more
useful than one that arrives after exhausting it.`;
const SESSION_DELEGATION_APPEND = `When the user asks you to create, start, delegate to, or run work in another session,
use the Peon session tools, especially \`peon_sessions.spawn_sessions\`. This includes requests that name a model or
reasoning effort for the new session. A Peon child session is durable, visible in Overseer, and linked to this session.
Do not use provider-native sub-agents for user-visible delegation and do not present a provider-native sub-agent as a
Peon session. Provider-native sub-agents are allowed only when the user explicitly asks for ephemeral internal
parallelism rather than another Peon session.`;
const OUTCOME_CONTRACT_APPEND = `Your final response must report an outcome:
- result: "success" only if you fully completed the task as described.
- result: "needs_human" if you're blocked on a decision, missing information, or ambiguity that
  only a human can resolve — the task itself is fine, you just can't safely guess past this
  point (e.g. missing credentials only a human has, conflicting instructions, a required piece
  of info that was never provided).
- result: "failure" for anything else — a hard error, a broken environment, a missing
  capability, or a wall you hit that isn't a question for a human to answer.
- summary: a specific, concrete description. For "needs_human", state exactly what's missing
  or ambiguous and what a human needs to provide or decide to unblock you. For failures, state
  exactly what wall you hit (error text, environment problem) so a human can act on it without
  re-reading the whole transcript. For success, briefly state what was done.

Always report an outcome, even if you are certain you failed immediately. This applies to every
message you're asked to respond to, including follow-ups sent after you already concluded —
each one gets its own fresh outcome, which may differ from your previous one.`;
function buildProjectContext(project) {
    const guidance = `This session belongs to the Peon project ${project.label} (${project.key}). Its working
directory is ${project.dir}. Project documentation lives in ${project.dir}/docs. When project
context, architecture, setup, workflows, or operational details are relevant, read
docs/index.md first and follow its links to the necessary pages. Keep durable project
documentation in docs/ when the task requires updating it. When the user asks you to remember
project information or instructions, persist them in docs/. Put focused details in a focused
document. Put critical instructions and processes that should apply to every task directly in
docs/index.md, because that index is injected into every linked session's main prompt.
Repository instruction files such
as CLAUDE.md or AGENTS.md are not a substitute for the project documentation. When creating or
editing links between files in docs/, use Markdown paths relative to the document containing
the link, and make sure the normalized target remains inside docs/. Do not use absolute
filesystem paths or file:// URLs for documentation cross-references. Relative ../ segments are
valid only when they still resolve within docs/; external https:// links are allowed. Before
finishing a documentation change, verify that every modified local cross-reference resolves to
an existing file inside docs/.`;
    try {
        const index = readProjectDoc(project.dir, PROJECT_DOCS_INDEX);
        const content = index.content.trim();
        if (!content)
            return guidance;
        const truncationNotice = index.truncated
            ? "\n\n[The injected index is truncated; read docs/index.md before relying on omitted content.]"
            : "";
        return `${guidance}\n\nProject documentation index (docs/index.md, injected into the main prompt):\n\n${content}${truncationNotice}`;
    }
    catch {
        // A missing or temporarily unreadable index must not prevent a session from
        // starting. The guidance above tells the agent where durable context belongs.
        return guidance;
    }
}
export function buildSystemPrompt(expectsOutcome, candidates, previewDir, project, soul, currentUser, allowSessionSpawning = false) {
    let prompt = expectsOutcome
        ? `${BASE_SYSTEM_PROMPT}\n\n${OUTCOME_CONTRACT_APPEND}`
        : BASE_SYSTEM_PROMPT;
    if (currentUser) {
        prompt += `\n\nThe current Peon user is ${currentUser}. When this user refers to “me”, “myself”, or similar
first-person language in a request involving people or ownership, use ${currentUser} as their
identity (for example, as the assignee when they ask you to assign a task to them).`;
    }
    if (allowSessionSpawning)
        prompt += `\n\n${SESSION_DELEGATION_APPEND}`;
    const peonSoul = soul?.trim();
    if (peonSoul) {
        prompt += `\n\nPeon soul (Markdown):\n${peonSoul}`;
    }
    if (project)
        prompt += `\n\n${buildProjectContext(project)}`;
    if (candidates.length === 0)
        return prompt;
    const list = candidates.map((project) => `- ${project.key}: ${project.label} (dir: ${project.dir})`).join("\n");
    prompt += `\n\nThis session was not started with a specific project attached. Here are the known projects:

${list}

If this task relates to one of them, cd into its directory before doing any work. In your final report, state which project
(by key) you determined this task belongs to, or say that none of them apply.`;
    return prompt;
}
// The transcript retains the human's original text; absolute attachment paths
// are added only to the prompt sent to the coding agent.
export function buildAugmentedPrompt(prompt, attachments) {
    if (attachments.length === 0)
        return prompt;
    const line = (attachment) => `- ${attachment.path} (${attachment.originalName})`;
    const images = attachments.filter((attachment) => attachment.mimetype.startsWith("image/"));
    const files = attachments.filter((attachment) => !attachment.mimetype.startsWith("image/"));
    const sections = [];
    if (files.length > 0) {
        sections.push(`Attached file(s) — read these before proceeding:\n${files.map(line).join("\n")}`);
    }
    if (images.length > 0) {
        sections.push(`Attached image(s) — use Read to view each one (they are shown to you visually) before proceeding:\n${images.map(line).join("\n")}`);
    }
    return `${prompt}\n\n${sections.join("\n\n")}`;
}
