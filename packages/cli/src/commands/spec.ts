/**
 * `cfcf spec [task...]` -- launch the Product Architect (PA).
 *
 * PA is the cf² SDLC role responsible for authoring + iterating the
 * Problem Pack (`<repo>/problem-pack/{problem,success,constraints,
 * hints,style-guide}.md` + `context/`). Peer to dev / judge /
 * Solution Architect / reflection / documenter; sits at the START
 * of the cf² development flow:
 *
 *   cfcf workspace init    create the workspace shell (problem-pack/)
 *   cfcf spec              <-- this command: PA authors Problem Pack
 *   cfcf review            Solution Architect: reviews + emits plan.md
 *   cfcf run               dev/judge/reflect loop
 *   cfcf reflect           ad-hoc strategic reflection
 *   cfcf document          final docs (auto on SUCCESS)
 *
 * **Interactive, by design.** PA's agent CLI takes over the user's
 * current shell until exit -- like `cfcf help assistant`. Live spec
 * iteration is inherent to PA's job; no signal-file workflow could
 * substitute for back-and-forth refinement.
 *
 * **No pre-flight gate (v2).** PA always launches given a folder.
 * The system prompt instructs the agent to drive `git init` /
 * `cfcf workspace init` itself when those are missing.
 *
 * **Pattern A injection** + `--cd <repo>` so the agent's bash tool
 * operates relative to the user's repo (correct for editing
 * problem-pack/ + running cfcf commands).
 *
 * Plan item 5.14 (v2). Design: docs/research/product-architect-design.md.
 */

import type { Command } from "commander";
import {
  readConfig,
  assembleProductArchitectPrompt,
  launchProductArchitect,
  assessState,
  readMemoryInventory,
  type AgentConfig,
} from "@cfcf/core";

/**
 * Default first user message when the user runs `cfcf spec` without a
 * positional task. Triggers PA's session-start protocol immediately
 * (greet + state summary + git/workspace branches + open the
 * conversation) so the TUI never opens to an empty prompt.
 *
 * Phrased as a user request because both claude-code and codex treat
 * the positional [PROMPT] as the user's first message in conversation.
 */
const DEFAULT_GREETING_PROMPT =
  "Please run your session-start protocol now: introduce yourself briefly, " +
  "summarise what you found in the state assessment (git status, workspace " +
  "registration, problem-pack state, server status, prior memory), branch " +
  "appropriately on git/workspace registration, and ask me how I'd like to " +
  "proceed.";

interface SpecOptions {
  /** Repo path to operate on. Defaults to process.cwd(). */
  repoPath?: string;
  /** Override config.productArchitectAgent (claude-code, codex). */
  agent?: string;
  /** Print the assembled system prompt + exit; don't launch. */
  printPrompt?: boolean;
  /**
   * Optional positional task (joined from `[task...]`). Surfaced in
   * the system prompt's "Initial task" section so PA opens with a
   * concrete first message.
   */
  initialTask?: string;
}

async function runSpec(opts: SpecOptions): Promise<void> {
  // 1. Resolve config + the PA agent.
  let config;
  try {
    config = await readConfig();
  } catch (err) {
    console.error(`Failed to read cfcf config: ${err instanceof Error ? err.message : String(err)}`);
    console.error("Run \`cfcf init\` to create the config first.");
    process.exit(1);
  }
  if (!config) {
    console.error("cfcf is not configured. Run \`cfcf init\` first.");
    process.exit(1);
  }
  const agent: AgentConfig = opts.agent
    ? { adapter: opts.agent }
    : config.productArchitectAgent ?? config.architectAgent ?? config.devAgent;

  // 2. Run state assessment (cheap; ~100ms typical).
  // Generates a fresh session_id internally; we surface it in the prompt.
  const repoPath = opts.repoPath ?? process.cwd();
  const state = await assessState({ repoPath });

  // 3. Best-effort: load Clio memory inventory (PA workspace doc + global
  // doc + read-only other-role inventory). Survives Clio being
  // unreachable: the system prompt explicitly handles the empty case.
  let memory;
  try {
    const { getClioBackend } = await import("@cfcf/core");
    const backend = getClioBackend();
    memory = await readMemoryInventory(backend, state.workspace.workspaceId);
  } catch (err) {
    console.error(
      `[pa] note: couldn't read Clio memory (${err instanceof Error ? err.message : String(err)}). ` +
      `Continuing without memory inventory; PA will still work.`,
    );
    memory = {
      workspace: { documentId: null, updatedAt: null, content: null },
      global: { documentId: null, updatedAt: null, content: null },
      otherRoles: [],
    };
  }

  // 4. Compose the system prompt.
  const systemPrompt = assembleProductArchitectPrompt({
    state,
    memory,
    initialTask: opts.initialTask,
  });

  // 4b. Compute the first user message (Flavour A — agent self-introduces
  // on launch, no need for the user to type "hello" first). Both claude
  // and codex accept a positional [PROMPT] that becomes the user's
  // opening message in interactive mode.
  const firstUserMessage = opts.initialTask
    ? opts.initialTask
    : DEFAULT_GREETING_PROMPT;

  // 5. --print-prompt escape hatch: emit the prompt + exit.
  if (opts.printPrompt) {
    process.stdout.write(systemPrompt);
    if (!systemPrompt.endsWith("\n")) process.stdout.write("\n");
    process.stderr.write(
      `\n[pa] would have launched: ${agent.adapter}` +
      (agent.model ? ` --model ${agent.model}` : "") +
      ` (session ${state.sessionId}; ${systemPrompt.length} chars total; ` +
      `git=${state.git.isGitRepo ? "yes" : "no"}, ` +
      `workspace=${state.workspace.registered ? state.workspace.name : "unregistered"}, ` +
      `problem-pack=${state.problemPack.exists ? "exists" : "missing"})\n`,
    );
    return;
  }

  // 6. Print a one-line preface, then hand off to the agent's TUI.
  const modelLabel = agent.adapter === "claude-code"
    ? ` (${agent.model ?? "sonnet"})`
    : agent.model ? ` (${agent.model})` : "";
  console.error(`[Product Architect (pa)] launching ${agent.adapter}${modelLabel}; session ${state.sessionId}.`);
  console.error(`[Product Architect (pa)] working dir: ${state.repoPath}`);
  console.error(`[Product Architect (pa)] cache: ${state.repoPath}/.cfcf-pa/ (memory + scratchpad)`);
  if (!state.git.isGitRepo) {
    console.error(`[Product Architect (pa)] note: this isn't a git repo yet — PA will offer to run \`git init\`.`);
  }
  if (!state.workspace.registered) {
    console.error(`[Product Architect (pa)] note: no cfcf workspace registered — PA will drive \`cfcf workspace init\` first.`);
  }
  if (agent.adapter === "codex") {
    console.error(`[Product Architect (pa)] tip: type \`/fast\` inside codex to switch to a faster/cheaper model for this session.`);
  }
  console.error("");

  try {
    const result = await launchProductArchitect({
      agent,
      state,
      systemPrompt,
      firstUserMessage,
    });
    if (result.exitCode !== 0 && result.exitCode !== null) {
      console.error(`\n[pa] agent exited with code ${result.exitCode}`);
      process.exit(result.exitCode);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[pa] failed to launch: ${msg}`);
    console.error("Run \`cfcf doctor\` to verify the agent CLI is on PATH.");
    process.exit(1);
  }
}

export function registerSpecCommand(program: Command): void {
  program
    .command("spec [task...]")
    .description(
      "Launch the Product Architect: interactively author + iterate the Problem Pack " +
      "(problem.md / success.md / constraints.md / etc.) for the current repo.",
    )
    .option("--repo <path>", "Repo path to operate on (defaults to current working directory)")
    .option("--agent <name>", "Override config.productArchitectAgent (claude-code, codex)")
    .option("--print-prompt", "Print the assembled system prompt + exit; don't launch")
    .action((task: string[], opts: { repo?: string; agent?: string; printPrompt?: boolean }) => {
      runSpec({
        repoPath: opts.repo,
        agent: opts.agent,
        printPrompt: opts.printPrompt,
        initialTask: task.length > 0 ? task.join(" ") : undefined,
      });
    });
}
