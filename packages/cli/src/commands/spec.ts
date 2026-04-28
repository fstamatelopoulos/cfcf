/**
 * `cfcf spec [task...]` -- launch the Product Architect (PA).
 *
 * PA is the cf² SDLC role responsible for authoring + iterating the
 * Problem Pack (`<repo>/cfcf-docs/{problem,success,process,
 * constraints}.md`). Peer to dev / judge / Solution Architect /
 * reflection / documenter; sits at the START of the cf² development
 * flow:
 *
 *   cfcf workspace init    create the workspace shell (cfcf-docs/)
 *   cfcf spec              <-- this command: PA authors Problem Pack
 *   cfcf review            Solution Architect: reviews + emits plan.md
 *   cfcf run               dev/judge/reflect loop
 *   cfcf reflect           ad-hoc strategic reflection
 *   cfcf document          final docs (auto on SUCCESS)
 *
 * **Interactive, by design.** Unlike the other SDLC role verbs
 * (`review` / `reflect` / `document`), which run non-interactively
 * (fire-and-forget agent process; structured signal files), PA's
 * agent CLI takes over the user's current shell until exit -- the
 * same pattern as `cfcf help assistant`. Live spec iteration with
 * the user is inherent to PA's job; no signal-file workflow could
 * substitute for back-and-forth refinement.
 *
 * **Hard "no implementation drift" boundary** in the system prompt:
 * PA declines requests to write code, design architecture, or
 * implement features and redirects to dev / Solution Architect /
 * Help Assistant.
 *
 * Pattern B injection: PA writes its system prompt to
 * `<repo>/cfcf-docs/AGENTS.md` (codex auto-load) +
 * `<repo>/cfcf-docs/CLAUDE.md` (claude-code auto-load), then spawns
 * the agent with `--cd <repo>/cfcf-docs/` so each CLI loads the
 * briefing as the deepest-scope file. Files are sentinel-marked
 * (<!-- cfcf:begin --> ... <!-- cfcf:end -->); user content outside
 * the markers is preserved byte-for-byte across launches.
 *
 * Plan item 5.14. Design: docs/research/product-architect.md.
 */

import type { Command } from "commander";
import {
  readConfig,
  assembleProductArchitectPrompt,
  launchProductArchitect,
  loadPaMemoryInventory,
  readProblemPackState,
  type AgentConfig,
} from "@cfcf/core";

interface SpecOptions {
  /**
   * Repo path to operate on. Defaults to process.cwd(). Pattern B
   * requires `<repoPath>/cfcf-docs/` to exist; the launcher errors
   * with a `cfcf workspace init` hint when it doesn't.
   */
  repoPath?: string;
  /** Override config.productArchitectAgent (claude-code, codex). */
  agent?: string;
  /** Print the assembled system prompt + exit; don't launch. */
  printPrompt?: boolean;
  /**
   * Optional positional task (joined from `[task...]`). Surfaced in
   * the system prompt's "Initial task" section so PA opens with a
   * concrete first message rather than a generic greeting.
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

  // 2. Best-effort: load Clio memory inventory (PA + global).
  let memoryInventory: string[] = [];
  try {
    const { getClioBackend } = await import("@cfcf/core");
    const backend = getClioBackend();
    memoryInventory = await loadPaMemoryInventory(backend);
  } catch (err) {
    console.error(
      `[pa] note: couldn't read Clio memory (${err instanceof Error ? err.message : String(err)}). ` +
      `Continuing without memory inventory; PA will still work.`,
    );
  }

  // 3. Read current Problem Pack state from <repo>/cfcf-docs/.
  // Survives the missing-directory case -- the formatter renders an
  // explicit "doesn't exist + run cfcf workspace init" hint that PA
  // sees in its system prompt and the launcher itself errors out
  // before spawn. Either way the user gets an actionable message.
  const repoPath = opts.repoPath ?? process.cwd();
  const workspace = await readProblemPackState(repoPath);

  // 4. Compose the system prompt.
  const systemPrompt = assembleProductArchitectPrompt({
    workspace,
    memoryInventory,
    initialTask: opts.initialTask,
  });

  // 5. --print-prompt escape hatch: emit the prompt + exit.
  if (opts.printPrompt) {
    process.stdout.write(systemPrompt);
    if (!systemPrompt.endsWith("\n")) process.stdout.write("\n");
    process.stderr.write(
      `\n[pa] would have launched: ${agent.adapter}` +
      (agent.model ? ` --model ${agent.model}` : "") +
      ` (${memoryInventory.length} memory project(s) read; ${systemPrompt.length} chars total; ` +
      `cfcf-docs ${workspace.exists ? "found" : "MISSING"} at ${workspace.cfcfDocsPath})\n`,
    );
    return;
  }

  // 6. Pre-flight: PA requires cfcf-docs/ to exist (Pattern B). If
  // it doesn't, refuse to launch with an actionable hint.
  // (--bootstrap mode that lets PA do this for the user is on the
  // v2 roadmap; for v1 the user runs `cfcf workspace init` first.)
  if (!workspace.exists) {
    console.error(`[pa] ${workspace.cfcfDocsPath} doesn't exist.`);
    console.error("");
    console.error("The Product Architect needs cfcf-docs/ to anchor its briefing");
    console.error("files (the agent reads cfcf-docs/AGENTS.md or CLAUDE.md as its");
    console.error("system prompt at session start).");
    console.error("");
    console.error("To bootstrap a fresh project:");
    console.error("  1. cd into your repo (or create one: `git init <name> && cd <name>`)");
    console.error("  2. Run \`cfcf workspace init\` to create cfcf-docs/");
    console.error("  3. Re-run \`cfcf spec\`");
    console.error("");
    console.error("(--bootstrap mode that lets PA do this for you is on the v2 roadmap.)");
    process.exit(2);
  }

  // 7. Print a one-line preface so the user knows what's happening,
  // then hand off to the agent's TUI.
  const modelLabel = agent.adapter === "claude-code"
    ? ` (${agent.model ?? "sonnet"})`
    : agent.model ? ` (${agent.model})` : "";
  console.error(`[Product Architect (pa)] launching ${agent.adapter}${modelLabel}; type your spec ideas. Ctrl-D to exit.`);
  console.error(`[Product Architect (pa)] briefing: ${workspace.cfcfDocsPath}/{AGENTS,CLAUDE}.md (auto-managed; user content outside the cf² markers is preserved).`);
  if (agent.adapter === "codex") {
    console.error("[Product Architect (pa)] tip: type `/fast` inside codex to switch to a faster/cheaper model for this session.");
  }
  console.error("");

  try {
    const result = await launchProductArchitect({
      agent,
      repoPath,
      systemPrompt,
      initialTask: opts.initialTask,
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
      "(problem.md / success.md / process.md / constraints.md) for the current repo.",
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
