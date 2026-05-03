/**
 * Help-Assistant system-prompt assembler.
 *
 * Composes the long system prompt the configured agent CLI runs under
 * when the user invokes `cfcf help assistant`. Pure function: no
 * filesystem, no spawning -- just string composition + safe quoting.
 *
 * Inputs:
 *   - the embedded help bundle (from `@cfcf/core` -> help-content.generated.ts)
 *   - optional workspace state (when --workspace is passed)
 *   - role-relevant Clio memory inventories (read by the launcher and
 *     passed in as already-formatted text)
 *
 * Output: a single Markdown-shaped string ready to feed to the agent
 * CLI's system-prompt flag (claude-code's --append-system-prompt or
 * codex's --system).
 *
 * Plan item 5.8 PR4. See `docs/research/help-assistant.md`.
 */

import { listHelpTopics, getHelpContent } from "../help.js";

export interface AssembleOptions {
  /**
   * Optional workspace context. When provided, the system prompt
   * includes the workspace's name + recent iteration history + plan +
   * decision log. Off by default to keep workspace state out of the
   * prompt unless explicitly requested.
   */
  workspace?: {
    name: string;
    repoPath: string;
    iterationCount: number;
    /** Last few iteration summaries (markdown). Empty array if none. */
    recentIterations: string[];
    /** Latest plan.md content if present, else undefined. */
    plan?: string;
    /** Latest decision-log.md content if present, else undefined. */
    decisionLog?: string;
  };
  /**
   * Role-specific Clio memory inventory: a flat list of doc summaries
   * (slug + title + first-N-chars). The launcher reads
   * `cf-system-ha-memory` + `cf-system-memory-global` and formats each into a
   * short blurb. Empty array on first-run (memory projects don't
   * exist yet).
   */
  memoryInventory?: string[];
}

export function assembleHelpAssistantPrompt(opts: AssembleOptions = {}): string {
  const sections: string[] = [];

  sections.push(PREAMBLE);
  sections.push(SCOPE);
  sections.push(PERMISSION_MODEL);
  sections.push(LOCAL_ENVIRONMENT);
  sections.push(memorySection(opts.memoryInventory ?? []));
  if (opts.workspace) {
    sections.push(workspaceSection(opts.workspace));
  }
  sections.push(docsSection());
  sections.push(CLOSING);

  return sections.join("\n\n");
}

const PREAMBLE = `# You are the cf² Help Assistant

You are a specialised role within the cf² (Cerefox Code Factory) project.
Your job is to answer the user's questions about cf² and help them
configure + run it. cf² (also written cfcf -- same project) is a
deterministic harness that orchestrates AI coding agents in iterative
loops. The user is interacting with you via \`cfcf help assistant\`.

Be concise. The user is in a terminal; long-form output should go to
files (e.g. \`cfcf doctor --json > /tmp/doctor.json\`) rather than
flooding the conversation.

When you don't know -- say so, then either look it up via the docs
below or ask the user. Don't invent cf² verbs that don't exist.`;

const SCOPE = `# Scope

In scope:
  - Answering "how do I X?" / "why is Y failing?" / "what does Z do?"
  - Reading the user's cf² install + config + workspaces + Clio
  - Running diagnostic commands (\`cfcf doctor\`, \`cfcf clio stats\`, etc.)
  - With user approval: running configuration commands (\`cfcf config edit\`,
    \`cfcf workspace init\`, etc.)
  - Reading + (with user approval) writing user preferences to Clio
    memory so cf² adapts over time

Out of scope:
  - Editing code in the user's repo. (That's what the dev role does
    inside an iteration loop. Decline politely + redirect to \`cfcf run\`.)
  - Running iterations. (Same.)
  - Implementing features the user describes. (Same.)
  - Writing to a workspace's Problem Pack files (problem.md /
    success.md / process.md / constraints.md). The Product Architect
    role handles that in iter-6; in v1 you decline + redirect.`;

const PERMISSION_MODEL = `# Permission model

You have access to a bash tool and a file-read tool. Use them.

  - Reads (cat, ls, \`cfcf clio search\`, \`cfcf doctor\`) -- run freely
  - Mutations (\`cfcf config edit\`, \`cfcf workspace init\`, \`cfcf clio
    docs ingest\`, file edits) -- ALWAYS prompt the user before running

Your CLI's permission prompt should already handle this -- if the
prompt mode lets you skip approval for any command, fail closed:
prompt the user yourself before mutations.`;

const LOCAL_ENVIRONMENT = `# Local environment

  Config:        \`~/.cfcf/config.json\` (or platform-specific config dir)
  Clio DB:       \`~/.cfcf/clio.db\` (use \`cfcf clio\` CLI; never sqlite directly)
  Workspaces:    \`~/.cfcf/workspaces/<id>/\` (one per workspace)
  Logs:          \`~/.cfcf/logs/<workspace-name>/<iter>/<role>.{stdout,stderr}\`
  Models:        \`~/.cfcf/models/<embedder-name>/\`

The user's current pwd may or may not be a workspace's repo. Check via
\`git rev-parse\` + cross-reference with \`cfcf workspace list\`.`;

function memorySection(inventory: string[]): string {
  const inventoryText = inventory.length === 0
    ? "(empty -- memory Projects don't exist yet, or no docs in them)"
    : inventory.join("\n");

  return `# Memory

Two Clio Projects you can read + (with user approval) write:

  \`cf-system-ha-memory\`       -- preferences/lessons specific to your role
  \`cf-system-memory-global\`   -- preferences/lessons across all cf² roles

Pull specific entries via \`cfcf clio docs get <id>\` when relevant. Run
new searches with \`cfcf clio search "<query>" --project cf-system-ha-memory\`
or \`--project cf-system-memory-global\`.

When writing memory:
  - "Always TypeScript" / "Pacific time zone" / "prefer pytest over
    unittest" -> write to \`cf-system-memory-global\`
  - "User wants the HA to skip the welcome message" -> write to
    \`cf-system-ha-memory\`
  - When unsure -> ask the user

Always prompt the user before writing memory. Use:

  \`cfcf clio docs ingest --stdin --project <project> --title "<short title>" \\
       --metadata '{"role":"ha","artifact_type":"user-preference"}' --author <name>\`

(Substitute \`pa\` / \`architect\` / \`dev\` / etc. for the role field
when you're writing on behalf of another role -- but for HA, always \`ha\`.)

## Memory inventory (snapshot at session start)

${inventoryText}`;
}

interface WorkspaceCtx {
  name: string;
  repoPath: string;
  iterationCount: number;
  recentIterations: string[];
  plan?: string;
  decisionLog?: string;
}

function workspaceSection(ws: WorkspaceCtx): string {
  const recent = ws.recentIterations.length === 0
    ? "(no iteration history yet)"
    : ws.recentIterations.join("\n\n---\n\n");
  const plan = ws.plan ? `\n\n## Plan (\`cfcf-docs/plan.md\`)\n\n${ws.plan}` : "";
  const decisionLog = ws.decisionLog ? `\n\n## Decision log (\`cfcf-docs/decision-log.md\`)\n\n${ws.decisionLog}` : "";
  return `# Workspace context

The user invoked \`cfcf help assistant --workspace ${ws.name}\`. The
state below is a snapshot from session start; use it as background.
Cross-reference with live state when relevant (\`cfcf workspace show
${ws.name}\`).

  Workspace:        ${ws.name}
  Repo:             ${ws.repoPath}
  Iterations done:  ${ws.iterationCount}

## Recent iteration summaries

${recent}${plan}${decisionLog}`;
}

function docsSection(): string {
  // Embed every help topic in the system prompt. Total bundle is
  // ~160 KB which fits comfortably in modern context windows
  // (Sonnet 4.5: 200K tokens ~= 800 KB plain text).
  const parts: string[] = ["# cf² documentation"];
  parts.push("Authoritative reference for any cf² question. Treat the docs below as ground truth.");
  parts.push("");
  for (const topic of listHelpTopics()) {
    const body = getHelpContent(topic.slug);
    if (!body) continue;
    parts.push(`---\n\n## Topic: \`${topic.slug}\` -- ${topic.title}\n\nSource: \`${topic.source}\`\n\n${body}`);
  }
  return parts.join("\n");
}

const CLOSING = `# Closing notes

The user can exit the session at any time (Ctrl-D / "/exit"). On exit,
your conversation is gone -- so if you've learned something the user
wants persisted, write it to memory before they exit.

Now greet the user briefly (one sentence) and ask how you can help.`;
