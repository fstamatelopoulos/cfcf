# cfcf: Cerefox Code Factory -- Requirements & Vision v0.4

*cfcf is pronounced "cf square" and may be written as cf² in documentation. Code and package names always use `cfcf`.*

**Author:** Fotis Stamatelopoulos (with Claude)
**Status:** Living Document
**Date:** April 2026
**Parent Brand:** Cerefox
**Related Documents:** cfcf-stack.md, agent-process-and-context.md, technical-design.md, ../plan.md, ../api/server-api.md
**Changelog:** v0.4 decouples cfcf from Cerefox as a hard dependency (self-contained file-based memory layer, Cerefox as optional backend), removes Cerefox Agent references (conceptual predecessor, not a product), resolves several open design questions, and adds long-term vision for coordinator agent pattern. v0.3 renames project to cfcf (from CF-CF), updates tech stack references to TypeScript/Bun (documented separately), clarifies human-on-the-loop model with configurable N-iteration pause cadence, and expands the target agent set to reflect the broader ecosystem.

---

## 1. Executive Summary

cfcf (Cerefox Code Factory) is a lightweight, open-source orchestration harness that runs autonomous AI coding agents in iterative loops against a user-defined problem until success criteria are met or iteration limits are reached. The user defines the problem via documentation files (Markdown with optional Mermaid diagrams); cfcf's Mission Control prepares each iteration by writing accumulated context -- problem definition, success metrics, test scenarios, decision logs, plans, and iteration history -- into the project repo, then launches the agent, evaluates results via a separate judge agent, and decides whether to continue, adjust, or stop.

**cfcf is deterministic orchestration, not another AI agent.** The control loop is plain code, not an LLM. LLMs do the coding work as agent processes; cfcf does the plumbing, context assembly, evaluation, and iteration management. LLMs are used as utility functions at specific points in the loop: an LLM judge assesses iteration quality beyond what tests can capture, and SLMs assist with context preparation tasks like log summarization and failure classification. These LLM invocations are tools called by the deterministic harness -- they inform decisions but do not make them.

**cfcf is vendor, agent, and model agnostic at its core.** Claude Code and Codex CLI are primary reference implementations, but the agent interface is a plugin contract. Any CLI-based AI coding agent -- OpenCode, Cline, Goose, OpenHands, Cursor Agent, Aider, and others -- can be supported via an adapter. No LLM vendor SDK is a first-class dependency of cfcf's core; vendor SDKs live exclusively inside agent adapters and evaluation utility modules.

**Iterations run uninterrupted and headless by design.** The human user is on the loop, not in it. The user may configure cfcf to pause every N iterations to review results, the plan, or the code, and optionally provide corrective direction or refined requirements before the next iteration begins. The default is fully autonomous iteration with no human interruption.

---

## 2. The Problem

Modern CLI coding agents (Claude Code, Codex, Aider, Goose, and others) are powerful but limited by session scope:

- Each invocation starts from scratch or with minimal context.
- There is no built-in mechanism to run an agent, evaluate its output, learn from failures, and retry with accumulated knowledge.
- Complex tasks requiring multiple iterations of "code, test, fix, rethink" are managed manually by the developer.
- Context from previous attempts is lost unless the developer manually curates it.
- There is no standardized way to define success criteria that the system can check autonomously.

Beyond session scope, there is a **reflection gap**. Even when tests pass, important questions go unasked: Is the solution brittle? Is the agent circling the same approach? Should the strategy shift? Pure test-driven evaluation cannot answer these questions, yet they directly determine whether the iteration loop converges on a good solution or spins its wheels.

The developer ends up being the orchestration layer -- manually running agents, reading output, deciding what to try next, re-explaining context. This is the bottleneck cfcf eliminates.

---

## 3. Vision & Goals

### 3.1 Vision

cfcf is a **software factory** that takes a problem definition and iteratively applies autonomous coding agents until the problem is solved, using a multi-tiered evaluation strategy: test-driven checks as the primary signal, LLM-as-judge for qualitative assessment, and periodic strategic reflection to guide the iteration loop toward convergence.

### 3.2 Goals

1. **Zero-touch iteration**: Define the problem, set limits, walk away. Come back to either a solution or a detailed log of what was tried.
2. **Agent-agnostic**: Support any CLI coding agent through an adapter interface. Claude Code, Codex CLI, OpenCode, Cline, Goose, OpenHands, Cursor Agent, Aider, and future agents are all first-class targets.
3. **Model-agnostic**: No LLM vendor is embedded in cfcf's core. The judge, reflection, and SLM utility calls use an abstraction layer that supports any provider.
4. **Memory-backed context**: Each iteration starts with full accumulated knowledge -- not just the repo state, but what was tried, what failed, what was learned.
5. **Deterministic control**: The orchestration loop is predictable code -- no LLM in the critical path of control flow decisions.
6. **Intelligent evaluation**: Machine-checkable tests are the foundation, but LLM judges and periodic strategic reflection ensure the loop converges on quality solutions, not just passing tests.
7. **Controlled execution**: Each agent runs as a local process in the project directory on a dedicated git branch. State between iterations is managed explicitly via git commits and the cfcf context pipeline. Container-based isolation is a future option.
8. **Human on the loop**: Iterations are headless and uninterrupted by default. The user may configure a pause cadence (every N iterations) for review and course correction.
9. **Cheap to operate**: Run locally on a developer's machine. Costs are LLM API calls from the coding agents plus lightweight judge/SLM calls from the harness.

### 3.3 Long-Term Vision: Coordinator Agent Pattern

The initial implementation uses a single dev agent per iteration with a single non-interactive execution. The long-term vision evolves this into a **coordinator agent pattern**: a main agent that launches and directs sub-agents within each iteration, making execution more iterative and interactive. The coordinator would manage the plan, distribute work to specialist roles (coder, tester, documenter), and synthesize results -- all within the scope of a single iteration.

This does not contradict the deterministic outer loop. The outer loop (iteration lifecycle, environment setup, evaluation, continue/stop) remains deterministic code. The coordinator operates within the iteration boundary, replacing the single fire-and-forget agent invocation with a richer inner execution model.

The chief agent solves the **token bootstrapping problem**: instead of a single agent spending a large fraction of its context window re-reading all project context every iteration, the chief holds the big picture and spawns sub-agents with focused, minimal context for specific tasks. The chief uses cfcf CLI commands to spawn and manage sub-agents, and communicates with them via structured files in the repo. From cfcf's perspective, the iteration is still a single unit -- it just takes longer and involves multiple agent processes internally.

The path from v0.1 to this vision is incremental: first prove the loop works with a single agent (v0.1), then add the judge as a separate agent role (v0.1), then explore chief-subagent coordination within iterations (v0.4+).

### 3.4 Non-Goals (for v0.1)

- Multi-agent parallelism within a single iteration (one dev agent + one judge per iteration for now).
- Cloud-hosted execution (local-only for now).
- Container-based isolation (agents run as local processes; container mode is a future option).
- Web UI in v0.1 (CLI-first; GUI is a near-term addition for visualization, telemetry, and config management).
- Automatic problem decomposition (the user defines the problem).
- Support for non-coding tasks (research, content creation).

---

## 4. Core Concepts

### 4.1 Problem Pack

A directory of Markdown files that define the problem. This is the user's primary input to cfcf. Minimum contents:

- **problem.md** -- What needs to be built or fixed. Clear problem statement, constraints, existing context.
- **success.md** -- Machine-checkable success criteria. Primarily: which tests must pass. May also include lint rules, type-check requirements, and build success. May include qualitative criteria for the LLM judge.
- **tests/** -- Test files or test scenario definitions that the agent's output will be evaluated against.

Optional:
- **context/** -- Additional context files (architecture docs, API specs, Mermaid diagrams, existing code snippets, reference implementations).
- **constraints.md** -- Explicit constraints: "do not modify file X", "must use library Y", "must be backwards compatible with Z".
- **hints.md** -- Soft guidance: preferred approaches, known pitfalls, "try X before Y".

### 4.2 Mission Control

The deterministic orchestration layer. Responsibilities:

1. **Pre-iteration**: Assemble the context payload for the next agent iteration (Problem Pack + iteration history + accumulated learnings from the memory layer + judge/reflection outputs from previous iterations). If the user previously ran a Solution Architect review, include the architect's assessment as additional context.
2. **Launch**: Prepare the repo (write context files, ensure correct git branch), spawn the dev agent process.
3. **Post-iteration**: Collect results (code changes, test results, agent logs), invoke the judge agent, parse judge signals.
4. **Decision**: Continue, adjust (e.g., switch agent, modify hints), or stop (success or iteration limit). This is deterministic -- based on judge signals, not LLM reasoning.
5. **Human pause** (if configured): After every N iterations, or when the dev agent or judge requests user input, pause and surface a summary to the user, accept optional corrective direction or requirement refinements, then resume.

### Agent Roles

cf² manages four distinct agent roles, each independently configurable (agent adapter + model):

| Role | Purpose | When invoked |
|------|---------|-------------|
| **Solution Architect** | Reviews Problem Pack for completeness, feasibility, clarity. Advisory tool for the user, not a gate. | User-invoked (`cfcf review`), optional, can run multiple times |
| **Dev Agent** | Reads context, writes code, runs tests, produces handoff + signals. | Each iteration |
| **Judge** | Reviews iteration results, determines SUCCESS/PROGRESS/STALLED/ANOMALY. | After each iteration |
| **Documenter** | Produces polished final project documentation (architecture, API reference, setup guide). | Auto post-SUCCESS, or user-invoked (`cfcf document`) |

Cross-agent review is encouraged: e.g., Codex for dev, Claude Code for judge and architect, Claude with Opus for documenter. Different agents catch different types of issues.

Mission Control's control flow decisions are deterministic. All branching is based on test pass/fail status, iteration count vs. configured maximum, explicit rules (e.g., "if 3 consecutive failures with same error, stop and report"), and the N-iteration pause configuration.

LLMs are invoked as utility functions within the evaluation pipeline and during context preparation. Their outputs are logged to the memory layer and folded into subsequent iterations as advisory context. They do not drive continue/stop/adjust decisions directly.

### 4.3 Human-on-the-Loop Model

cfcf iterates headless by default. Iterations proceed without human interruption until success criteria are met, the iteration limit is reached, or a stop rule fires.

The user may configure a **pause cadence** via the `--pause-every` flag or config file:

- `--pause-every 1`: Pause after every iteration (highest control, slowest throughput).
- `--pause-every 3`: Pause every 3 iterations for a lightweight check-in.
- `--pause-every 0` (default): No pauses, fully autonomous.

At each configured pause, cfcf surfaces:
- Current iteration count and overall status.
- Test results from the last completed iteration.
- Judge assessment summary (if Tier 2 ran).
- Reflection output (if Tier 3 ran).
- Diff of changes made in the last iteration.
- The current plan.

The user may then:
- Resume without changes.
- Provide corrective directions or refined requirements (appended to the Problem Pack context for the next iteration).
- Update hints.md.
- Stop iterating.

This model preserves the headless, zero-touch default while giving users a natural checkpoint mechanism for longer or higher-stakes projects.

### 4.4 Iteration Cycle

```
┌──────────────────────────────────────────────────────────────────┐
│                    cfcf Mission Control                          │
│                    (deterministic control loop)                  │
└──────────┬──────────────────────────────────────────┬────────────┘
           │                                          │
           ▼                                          ▼
    ┌──────────────┐                         ┌──────────────────┐
    │ 1. PREPARE   │                         │ 6. DECIDE        │
    │              │                         │                  │
    │ Assemble     │                         │ Tests pass?      │
    │ context from │                         │ → SUCCESS        │
    │ Problem Pack │                         │                  │
    │ + memory     │                         │ Iteration limit? │
    │ + prev iter  │                         │ → STOP + REPORT  │
    │ + judge      │                         │                  │
    │   feedback   │                         │ Pause cadence?   │
    │              │                         │ → PAUSE + REVIEW │
    │ (SLM workers │                         │                  │
    │  summarize   │                         │ Otherwise?       │
    │  + classify) │                         │ → CONTINUE       │
    └──────┬───────┘                         └────────┬─────────┘
           │                                          │
           ▼                                          │
    ┌──────────────┐                                  │
    │ 2. LAUNCH    │◄─────────────────────────────────┘
    │              │
    │ Write context│
    │ files to repo│
    │ Spawn agent  │
    │ process      │
    └──────┬───────┘
           │
           ▼
    ┌──────────────┐
    │ 3. EXECUTE   │
    │ (agent runs) │
    │              │
    │ Agent works  │
    │ autonomously │
    └──────┬───────┘
           │
           ▼
    ┌───────────────────────────────────────────┐
    │ 4. EVALUATE (Three-Tier Pipeline)         │
    │                                           │
    │ Tier 1: MECHANICAL (every cycle)          │
    │   Run tests, lint, build                  │
    │   → pass/fail + structured results        │
    │                                           │
    │ Tier 2: JUDGE (configurable frequency)    │
    │   LLM reviews diff, test results, logs    │
    │   → quality assessment, tactical hints    │
    │                                           │
    │ Tier 3: REFLECT (configurable frequency)  │
    │   LLM reviews full iteration history      │
    │   → strategic guidance, pattern analysis  │
    │                                           │
    │ All outputs logged to memory layer        │
    └──────┬────────────────────────────────────┘
           │
           ▼
    ┌──────────────┐
    │ 5. SYNTHESIZE│
    │              │
    │ SLM workers  │
    │ compress logs│
    │ classify     │
    │ failures     │
    │ prepare next │
    │ iteration    │
    │ context      │
    └──────┬───────┘
           │
           └──────────────▶ back to step 6
```

### 4.5 Context Assembly

Each iteration's agent prompt is assembled from layers:

**Layer 1 -- Static (from Problem Pack):**
- problem.md content
- success.md content
- constraints.md content (if present)

**Layer 2 -- Accumulated (from memory layer):**
- Decision log: what approaches have been tried, what worked/didn't
- The plan: current implementation plan (may evolve across iterations)
- Iteration summary: current progress, passing/failing tests, error patterns
- Judge feedback from Tier 2 (if available)
- Strategic guidance from Tier 3 (if available)
- Human-provided corrective direction (if a pause review occurred)

**Layer 3 -- Adaptive (computed by Mission Control + SLM workers):**
- hints.md content (may be updated between iterations based on failure patterns or human input)
- Agent-specific instruction files (e.g., CLAUDE.md for Claude Code)
- Diff of changes made in the previous iteration
- SLM-generated summaries of previous iteration logs
- SLM-classified failure patterns

### 4.6 Repo Management

cfcf uses git branches for iteration isolation. GitHub is the supported remote for v0.1.

- Each iteration gets its own **feature branch** (`cfcf/iteration-N`) off main.
- The agent works directly on the local repo, on the iteration's feature branch.
- After each iteration: all changes (success or failure) are committed. The judge assessment is committed separately.
- On normal iteration completion: the feature branch is merged to main (via PR or direct merge, configurable). The user reviews the judge report.
- On success (all iterations complete): the final iteration's merge represents the completed work.
- On failure/anomaly: the feature branch remains unmerged. The user or next iteration can inspect and decide.
- Between iterations: cfcf branches off the updated main for the next iteration, regenerating CLAUDE.md and managed cfcf-docs/ files.

### 4.7 Secret Management

Agents use the user's existing local credentials and environment variables. cfcf does not manage API keys or agent authentication -- the user is responsible for having their agents properly authenticated before starting iteration. Project-specific secrets (e.g., database URLs, service tokens) can be configured in cfcf's project config and injected as environment variables. Secrets never appear in the memory layer or iteration logs.

---

## 5. Design Principles

1. **Deterministic control, non-deterministic workers.** The orchestration loop is predictable code. Creative, non-deterministic work happens inside agent processes and in evaluation utility calls. LLMs are invoked as functions, not as decision-makers.

2. **Tests are the foundation; judgment fills the gaps.** Machine-checkable tests are the primary success signal. The three-tier evaluation pipeline layers qualitative judgment on top of quantitative checks without replacing them.

3. **Accumulated context, not accumulated state.** Each iteration starts from a clean (or explicitly chosen) codebase state. Knowledge accumulates in the memory layer as structured Markdown documents, not as opaque model state.

4. **Agent-agnostic and model-agnostic.** cfcf is not coupled to any coding agent or LLM vendor. The agent interface is a plugin contract: accept a prompt and a repo, produce code changes and output logs. The evaluation utility layer uses a model abstraction that supports any provider.

5. **Human on the loop, not in it.** Iterations are headless and uninterrupted by default. Human review is an opt-in cadence, not a default interruption.

6. **Fail loudly, log everything.** Every iteration's full agent output, test results, judge assessments, and Mission Control decisions are logged to the memory layer. When cfcf stops, the developer can trace exactly what happened.

7. **The developer is the architect.** cfcf does not decompose problems or design solutions. The developer provides the problem definition, test cases, and constraints. The agent implements.

8. **Minimal infrastructure.** Local filesystem + git. No Docker, no Kubernetes, no cloud services, no additional databases. Agents run as local processes in the user's existing dev environment.

---

## 6. Target AI Coding Agents

cfcf supports any CLI-based AI coding agent via the adapter interface. Primary reference implementations for v0.1:

- **Claude Code** (Anthropic) -- primary reference implementation
- **Codex CLI** (OpenAI) -- primary reference implementation

Additional planned adapters:
- OpenCode
- Cline
- Goose (Block)
- OpenHands (All Hands AI)
- Cursor Agent
- Aider

The adapter interface is intentionally minimal so that adding new agents is straightforward as the ecosystem evolves. No adapter requires changes to cfcf core.

---

## 7. Agent Adapter Interface

Each supported coding agent implements a common adapter interface:

```
AgentAdapter:
  name: string                    # "claude-code", "codex", "opencode", ...

  check_availability() -> { available, version?, error? }
  # Verify the agent CLI is installed and authenticated

  prepare_context(
    problem_pack: ProblemPack,
    iteration_context: IterationContext,
    repo_path: string
  ) -> AgentInput
  # Translates cfcf's assembled context into agent-specific format
  # e.g., CLAUDE.md for Claude Code, config files for other agents

  build_command(input: AgentInput) -> { command, args[] }
  # Returns the CLI command to run this agent non-interactively
  # e.g., ["claude", "--dangerously-skip-permissions", "-p", "..."]

  unattended_flags() -> string[]
  # Agent-specific flags for unattended execution

  parse_output(
    logs: string,
    repo_path: string
  ) -> AgentOutput
  # Extracts structured results: files_changed, test_results,
  # agent_reasoning, errors, token_usage (best-effort)
```

Agent-specific logic is fully contained within the adapter. cfcf core has no knowledge of any particular agent's invocation format, output structure, or LLM vendor.

---

## 8. Memory Layer

For v0.1, **all cfcf-generated files live in the project repo** under `cfcf-docs/`. This is the source of truth. Everything is tracked in git -- the repo IS the memory layer. This keeps things simple, transparent, and version-controlled.

**Per-iteration artifacts (tracked in git under cfcf-docs/):**
- `plan.md` -- Evolving implementation plan (agent updates each iteration).
- `decision-log.md` -- Approaches tried, what worked/didn't, lessons learned.
- `iteration-handoff.md` -- Current iteration's handoff document.
- `cfcf-iteration-signals.json` -- Machine-readable iteration signals.
- `judge-assessment.md` -- Latest judge assessment.
- `cfcf-judge-signals.json` -- Machine-readable judge signals.
- `iteration-reviews/` -- Archived judge assessments per iteration.
- `iteration-history.md` -- Compressed summaries of all previous iterations.
- `iteration-logs/` -- Detailed per-iteration summaries.

**Agent logs (outside repo, under ~/.cfcf/):**
- Full agent stdout/stderr is too large for the repo. cfcf stores it under `~/.cfcf/logs/<project-id>/`.

**Cross-project knowledge** (e.g., which agents work best for which tasks, lessons across projects) is a future extension. The need will appear organically as cfcf evolves.

> **Note:** Cerefox (the Cerefox knowledge base) is supported as an optional future memory backend for richer semantic search across projects. Not required -- the built-in repo-based memory is fully functional on its own.

See `agent-process-and-context.md` section 7 for the full file structure specification.

---

## 9. Evaluation Strategy: The Three-Tier Pipeline

### 9.1 Tier 1: Mechanical Evaluation (every cycle)

The deterministic foundation. Fast, cheap, unambiguous.

- Run the project's test suite (or the subset specified in success.md).
- Parse results: total, passed, failed, errors.
- Run lint checks (if configured).
- Run type checks (if configured).
- Verify build succeeds.
- Compare against success criteria.

Tier 1 is the only tier that feeds into Mission Control's control flow. Pass/fail decisions and stop rules operate on Tier 1 outputs.

### 9.2 Tier 2: Judge Assessment (default: every cycle, configurable)

After Tier 1, Mission Control invokes a judge LLM -- a separate model call, distinct from the coding agent -- to review the iteration's output qualitatively. The judge receives the problem statement, the code diff, Tier 1 results, compressed agent logs, and the iteration history summary.

The judge produces a structured assessment: quality score, whether the approach is promising, specific concerns, tactical suggestions for the next iteration, and a summary for the iteration log.

The judge does not decide whether to continue or stop. Its output is logged to the memory layer and injected into the next iteration's context payload so the coding agent benefits from the feedback.

**Configuration:**
- `judge_frequency`: How often Tier 2 runs. Default: 1 (every cycle).
- `judge_model`: Configurable. Recommended frontier-class model.

### 9.3 Tier 3: Strategic Reflection (default: every 5 cycles, configurable)

Every N iterations, Mission Control invokes a deeper reflection pass. The reflection LLM reviews the full iteration history -- not just the latest iteration, but the accumulated pattern across all iterations in the project.

The reflection produces strategic guidance: pattern analysis across iterations, a strategy recommendation, suggestions for updating hints or the plan, and an iteration health assessment (converging, stalled, diverging).

Like Tier 2, the reflection output is advisory and logged to the memory layer. If the reflection flags that hints or the plan should be updated, Mission Control executes those updates as deterministic actions -- not LLM-driven control flow.

**Configuration:**
- `reflect_frequency`: How often Tier 3 runs. Default: 5 (every 5 cycles).
- `reflect_model`: Configurable, defaults to same as judge_model.

### 9.4 SLM Preparation Workers

Between iterations, the harness uses small/fast language models for preparation tasks: log compression, failure classification (is this the same error as a previous iteration?), and candidate hint generation. SLM workers are fast and cheap; their outputs are inputs to context assembly, not evaluations.

**Configuration:**
- `slm_model`: Configurable. Recommended fast/cheap model (local or API).

---

## 10. CLI Interface (Sketch)

```bash
# Initialize a new problem pack
cfcf init my-problem/

# Start iterating
cfcf iterate my-problem/ \
  --repo /path/to/project \
  --agent claude-code \
  --max-iterations 10 \
  --pause-every 3 \           # Human review every 3 iterations (0 = no pauses)
  --on-failure continue \     # or: stop, reset-and-retry
  --judge-frequency 1 \       # Tier 2 every cycle
  --reflect-frequency 5 \     # Tier 3 every 5 cycles
  --judge-model anthropic/claude-sonnet-4-20250514 \
  --slm-model ollama/llama3.2:3b

# Check status of a running project
cfcf status <project-name>

# Review iteration history
cfcf log <project-name>

# Apply the successful result to your repo
cfcf apply <project-name>

# List available agent adapters
cfcf agents

# Dry run -- show assembled context without launching
cfcf prepare my-problem/ --repo /path/to/project --agent claude-code
```

---

## 11. Relationship to Existing Projects

### Relationship to Cerefox

Cerefox is the overarching ecosystem. Currently it includes the Cerefox memory layer (an OSS project for persistent knowledge management) and cfcf. cfcf is the first concrete product in the ecosystem -- an instantiation of broader concepts around agent orchestration, structured operational knowledge (decision logs, plans, lessons), human-on-the-loop philosophy, and agent-agnostic design. cfcf has its own self-contained file-based memory layer, with optional Cerefox memory integration for richer semantic search across projects.

### vs. OpenHands

OpenHands is a full agent platform with its own agent loop, tool system, and sandbox runtime. cfcf is much simpler -- it wraps existing CLI agents rather than reimplementing the agent loop. cfcf is an outer loop around agents that already have their own inner loops.

### vs. ComposioHQ Agent Orchestrator

The most architecturally similar existing project. Key differences: cfcf is iterative (same problem, multiple attempts) vs. Composio's parallel (many issues, one attempt each); cfcf has persistent file-based memory across iterations vs. no persistent memory; cfcf is CLI-first and minimal vs. a full platform.

### vs. autoresearch (Karpathy)

Borrows the ratchet pattern (try, measure, keep-or-revert, repeat) but addresses a harder evaluation problem. "Did the code solve the problem" requires both mechanical checks and qualitative judgment. The three-tier evaluation pipeline is cfcf's answer to that gap.

### vs. SWE-bench/SWE-agent

SWE-bench is a benchmark; cfcf is a development tool. The evaluation harness pattern (isolated environment + test suite + pass/fail) is informed by SWE-bench's approach. cfcf extends it with an agent-based judge, strategic reflection, and persistent memory across iterations.

---

## 12. Cerefox Enterprise Knowledge Integration (Vision)

cf² is part of the broader Cerefox ecosystem. A critical component of the long-term vision is enterprise knowledge integration: connecting the AI dev agents that cf² manages to the organization's institutional knowledge.

### The Problem

AI coding agents today work with limited context: the code in the repo and whatever the user explicitly provides. They lack access to the organization's broader knowledge: business processes, product requirements, architectural decisions, API conventions, security guidelines, past incident learnings, and domain-specific context that experienced developers carry in their heads.

### The Vision: Cerefox Knowledge Crawler

An enterprise Cerefox deployment would include a knowledge crawler that integrates with the organization's existing systems:

- **Document storage**: Google Drive, SharePoint, Dropbox, local file servers
- **Communication**: Slack, Microsoft Teams, email archives
- **Knowledge bases**: Confluence, Notion, internal wikis
- **Project management**: Linear, Jira, Asana -- tickets, epics, roadmaps
- **Code repositories**: GitHub, GitLab -- existing codebases, PRs, code review history
- **Other sources**: CRM data, support tickets, onboarding docs, training materials

One or more AI agents process this ingested knowledge to produce:

- **Summaries** of business processes and domain concepts
- **Extracted guidelines**: coding standards, architectural patterns, security requirements
- **Institutional knowledge**: why certain decisions were made, what was tried and failed
- **Product context**: what the company builds, who the users are, what the priorities are
- **Cross-team insights**: patterns across projects, common pitfalls, shared components

### How cf² Leverages This Knowledge

When cf² assembles context for a dev agent iteration, it can query the Cerefox knowledge layer for relevant information:

- **Problem-specific context**: "This project involves payment processing" → Cerefox surfaces the company's payment API conventions, PCI compliance requirements, and relevant past projects.
- **Architectural guidance**: "This is a new microservice" → Cerefox surfaces the organization's microservice template, naming conventions, deployment patterns.
- **Code patterns**: "The agent is writing a REST API" → Cerefox surfaces the team's preferred error handling patterns, auth middleware, logging conventions.
- **Domain knowledge**: "The feature involves insurance claims" → Cerefox surfaces business rules, regulatory requirements, and domain terminology.

This context is injected into the agent's instructions (as additional Tier 2 or Tier 3 context files), significantly improving the accuracy and alignment of the agent's work with the organization's standards and knowledge.

### Integration Architecture

```
Cerefox Knowledge Layer (cloud or on-prem)
    │
    ├── Crawlers: Google Drive, Slack, Confluence, Jira, GitHub, ...
    ├── Processing: AI agents summarize, extract, classify
    ├── Storage: Hybrid search (semantic + keyword, as in current Cerefox OSS)
    │
    ▼
cf² Context Assembler
    │
    ├── Queries Cerefox for relevant knowledge based on problem.md keywords
    ├── Injects relevant context into cfcf-docs/context/ or CLAUDE.md
    │
    ▼
Dev Agent (enriched with organizational knowledge)
```

### Current State

This integration does not exist yet. cf² currently operates with only the context the user explicitly provides in the Problem Pack. The Cerefox OSS memory layer provides the foundation (hybrid search, document management), but the enterprise crawler and knowledge processing pipeline are future work.

The architecture is designed to be additive: when Cerefox enterprise knowledge becomes available, cf² can query it during context assembly without changes to the iteration loop, agent adapters, or user workflow.

---

## 13. Open Questions & Resolved Decisions

### Resolved

1. **Session continuity vs. fresh starts**: **RESOLVED -- Fresh agent session per iteration.** Each iteration spawns a new agent process. Context is assembled from files (Problem Pack + iteration history + judge feedback), not from agent session continuity. The agent reads all context at the start of each iteration. This avoids carrying forward bad assumptions. The repo state persists between iterations on the cfcf git branch.

2. **Iteration branching on failure**: **RESOLVED -- Commit everything, let the agent decide.** Even failed iterations are committed to the repo. The next iteration's agent analyzes the commits and docs and may decide to backtrack using git, potentially keeping some files. cfcf maintains copies of key files and logs in its external memory layer (~/.cfcf/).

3. **How the agent knows it's "done"**: **RESOLVED -- Agent returns = iteration done.** Each iteration is a single non-interactive agent execution. The agent is instructed to read context, formulate a plan, execute, and produce a handoff document. When the agent CLI process exits, the iteration is complete. No timeout initially -- the judge agent analyzes anomalous situations (token exhaustion, blocking questions) post-iteration.

4. **Agent interaction model**: **RESOLVED -- Fire-and-forget for v0.1.** cfcf launches the agent, captures logs via streaming, and waits for the process to exit. Full log capture is critical for the judge and for user review. Future versions may add more active monitoring.

### Open

5. **Token bootstrapping cost**: Each iteration requires the agent to re-read all context from scratch, which may consume a large percentage of available tokens. Mitigation strategies: (a) tightly defined process docs that tell the agent exactly what to read and in what order, (b) SLM-compressed summaries of previous iterations, (c) clear separation between "must read" and "reference only" context. This is an ongoing design challenge.

6. **Multi-agent within a project**: Could cfcf switch agents mid-project? The plugin model supports this, but orchestration logic gets more complex. Deferred to v0.4+.

7. **Cost tracking**: Should cfcf track LLM API costs per iteration and per project? Includes coding agent costs, judge costs, reflection costs, and SLM worker costs. Likely yes, but not a priority for v0.1.

8. **Judge disagreement with tests**: What if tests pass but the judge flags serious concerns? Should a sufficiently negative judge assessment block SUCCESS? TBD.

9. **Reflection-triggered escalation**: When Tier 3 identifies the loop as stalled or diverging, should cfcf have escalation rules (auto-switch agent, notify the developer)? TBD.

10. **Web GUI scope**: Minimum viable views? Candidates: iteration history and diffs, agent telemetry, configuration management, real-time log streaming. The server and web GUI are part of the first implementation (not deferred).

11. **Agent anomaly handling**: When the judge detects the agent ran out of tokens or is stuck waiting for user input, how should cfcf respond? Options: wait with timeout, notify user immediately, skip to next iteration. The judge needs structured output categories for this.

12. **Coordinator agent vision**: The long-term goal is a main agent that launches and directs sub-agents for each iteration, making execution more iterative and interactive within a single iteration. This is captured as the v0.4+ vision but not designed yet.

---

## 14. Repo Structure

The repo is a Bun monorepo with `packages/core`, `packages/server`, and `packages/cli`. See `README.md` at the repo root for the full structure. Documentation lives under `docs/` -- see `docs/README.md` for what goes where.

---

*This is a living document. It will evolve through experimentation and iteration.*
