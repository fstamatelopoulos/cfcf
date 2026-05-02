# PA + HA Web UI Integration — Investigation (plan item 5.15)

**Status:** research / decision document. No implementation.
**Date:** 2026-05-01.
**Cross-refs:** [`docs/plan.md`](../plan.md) row 5.15, [`docs/research/product-architect-design.md`](product-architect-design.md), [`docs/research/help-assistant.md`](help-assistant.md).

## Context — why this investigation

PA shipped in v0.16 (item 5.14) and HA shipped earlier (item 5.8) as **CLI-only interactive agents**: both inject a system prompt + take over the user's terminal stdio for the duration of a session. Plan item 5.15 was opened in iter-5 to ask whether the web UI can offer a meaningful integration beyond pointing the user at the CLI — and if so, what shape that integration should take.

The maintainer's prior was that there's no obvious browser-friendly equivalent for an interactive collaborative-spec or Q&A session, and that any non-trivial web integration would be expensive and likely fragile. This research was commissioned to either confirm or refute that prior, by surveying industry patterns + mapping cfcf's current state + sketching an options spectrum from "do nothing more" to "full web-first agent." The deliverable is this document — recommendations only, no code.

---

## TL;DR

**Recommendation: the **status mirror** + **transcript replay** pair covers ~80% of the user value at ~10% of the cost. Do small refinements to what's already there. Defer "drive PA/HA from the browser" indefinitely — the engineering cost is large, the security surface is real, and no comparable agent-CLI tool has solved it cleanly.**

The web UI already has more PA integration than I expected: History rows, an expandable detail panel with three tabs (session log + workspace summary + sync metadata), and a Status-tab indicator showing "PA session active (interactive — runs in user's terminal)." HA has zero web UI integration.

The honest case for 5.15 is: extend what's there a notch, don't rebuild. Specifically:
1. **Surface Clio doc activity** (PA writes new docs / new versions) in the History detail. (Currently the panel shows local `.cfcf-pa/` files but not the Clio writes that resulted.)
2. **Add HA to History** (or its own "Conversations" tab), even if minimal — HA is invisible today.
3. **Add an asciinema-style transcript** to PA + HA sessions for after-the-fact review. Cheap, optional, high ROI.
4. **Defer "interactive in browser"** until a user explicitly asks for it. The agent CLIs do have the protocol surface to enable it (Codex `app-server`, Claude Code `stream-json`), but the UX maintenance cost is permanent and the rationale is weak.

The body of this doc justifies that recommendation.

---

## 1. Current state — what the web UI already knows about PA/HA

Before answering "should we integrate," it's worth confirming what already exists. (Source: `packages/web/src/components/PaSessionDetail.tsx`, `packages/web/src/pages/WorkspaceDetail.tsx`, `packages/web/src/components/WorkspaceHistory.tsx`, `packages/web/src/types.ts`.)

### Product Architect — substantial coverage

- **History tab**: PA sessions appear as rows with type `"pa-session"`. Status column (`running` / `completed` / `failed`) is colour-coded; result column shows the agent-written `outcomeSummary` plus a badge with `decisionsCount`.
- **Detail panel** (expandable): metadata grid (session ID, timestamps, duration, exit code), pre-state bar (git status, workspace registration, problem-pack file count), outcome summary, Clio workspace-memory doc ID. Three tabs:
  - **Session log** — the live scratchpad (`.cfcf-pa/session-<id>.md`)
  - **Workspace summary** — the local mirror of `pa-workspace-memory`
  - **meta.json** — sync metadata
- **Status tab**: detects active PA sessions (`status === "running"`) and renders them with the explicit note **"(interactive — runs in the user's terminal)"** plus a click-through to History.
- **API**: `GET /api/workspaces/:id/pa-sessions/:sessionId/file` returns the file snapshot.

### Help Assistant — zero coverage

- HA is not in the History event union (`HistoryEventType = "review" | "iteration" | "document" | "reflection" | "pa-session"`).
- No detail panel, no Status indicator, no API endpoint.
- HA's design doc explicitly **defers web UI to iter-6**.

### What's NOT there for either role

- No mechanism for the browser to **launch** PA or HA. The user must open a terminal.
- No real-time **stdout/stderr stream** from the running agent process to the browser.
- No web-side **read or write** of Clio docs from the PA detail panel — the panel shows the local `.cfcf-pa/` files, not the canonical Clio content.
- No transcript / replay of past sessions beyond the agent-written scratchpad.

---

## 2. What "integration" could mean — define the spectrum first

Five distinct things people sometimes mean when they say "PA should be in the web UI":

| Level | What it means | Roughly = |
|---|---|---|
| **L0** | Web UI shows the session happened, with metadata and any agent-written summary. | Read-only after-the-fact reporting. |
| **L1** | Web UI shows the session is happening (status indicator, "active now"). | Live-ish dashboard. Polling is fine. |
| **L2** | Web UI shows what the agent wrote during the session (transcript / replay). | "Cast and replay" — async observability. |
| **L3** | Web UI controls session lifecycle (start, pause, abort) without typing into the agent. | "Status mirror with steering wheel." |
| **L4** | Web UI streams the agent's full I/O and lets the user type back. | "Web terminal embed" or "shadow chat." |
| **L5** | Web UI hosts a *separate* web-native PA/HA experience that shares memory/context with the CLI version. | "Two-surface agent." |

**cfcf today: L0 fully, L1 partially (PA only), L2-L5 not at all.**

Each level above L1 is a multiplicatively bigger commitment than the one below. The temptation in design discussions is to think about L4/L5 because that's "the cool one" — but every step up the ladder has its own engineering cost, security surface, and maintenance tail.

---

## 3. What other teams do — and what they don't

Detailed survey in the research notes; condensed here.

### The honest pattern observation

**No mainstream AI-coding-agent CLI** ships a primary web UI for the agent itself, as of 2026. Cursor / Windsurf / Zed AI are IDE-first (single surface). Claude.ai web / ChatGPT web are chat-first (single surface). Claude Code, Codex CLI, Aider are CLI-first (single surface, no real web). The closest exception is **Aider's `--browser` mode** (Streamlit-based) — and it's the cautionary tale: a separate code path that re-implements the chat loop, which lags behind the CLI's features. This is the "two-surface agent" failure mode.

### Where web terminals do appear

- **e2b.dev sandboxes** — embed xterm.js to let users *watch* an agent work in a remote container. The terminal is for **observability**, not the user's primary input.
- **Codespaces / Gitpod / code-server** — full xterm.js + node-pty in a hosted IDE. The terminal is real because the whole IDE is on the server. They've been working on terminal-emulation edge cases for years and still ship bug fixes.
- **Lens (kubectl frontend)** — has an in-app terminal; consistently the most-reported source of bugs in the project.

### Where teams explicitly chose NOT to integrate

- **Docker Desktop** — UI shows containers, logs, stats. For an interactive shell, click "Open in terminal" → shells out to your real terminal emulator. Stated rationale: terminal emulation is a deep, permanent cost; users have a terminal they like.
- **GitHub CLI vs github.com** — `gh` is CLI; the web does what the web does.
- **kubectl + most k8s dashboards** — dashboard surfaces logs + status; for `kubectl exec` you go to your terminal.

### The clean reference for "shared session, multiple clients"

**Jupyter.** The kernel is a long-running subprocess; both `jupyter console` (CLI) and the notebook UI are clients of the same kernel protocol (ZeroMQ + WS). This is the closest existing pattern to "L5 shadow chat" done well — and it took the Jupyter team ~10 years and a community to get there.

### Five patterns, with honest takes

1. **Cast and replay** (asciinema). Cheap, async-only. Right when the user's question is *"what happened"* not *"what's happening now."* Engineering cost: trivial. Maintenance: near-zero.
2. **Status mirror.** Web reflects state; CLI is the steering wheel. Engineering: moderate. Right when interaction is rare and structured (start/stop/pause), not conversational. **This is what cfcf already mostly does for the iteration loop, and largely does for PA today.**
3. **Shadow chat.** Web chat talks to the *same* agent process as the CLI (Jupyter pattern). Engineering: high — protocol, session multiplexing, chat UI. Right when the agent is genuinely the product. Failure mode: you've reinvented Jupyter without the ecosystem.
4. **Web terminal embed.** xterm.js + spawn the same CLI inside it. Engineering: medium for happy path; **high for production-quality** (PTY semantics, signals, paste safety, ANSI edge cases, mobile, accessibility). Security: real surface — even localhost-bound, any browser tab on the machine can reach it without auth. Failure mode: you become a terminal-emulator maintainer.
5. **Two-surface agent.** Separate web-native agent sharing memory. Engineering: doubles. Maintenance: doubles. Failure mode: Aider's browser mode.

---

## 4. cfcf-specific analysis

### Why PA and HA are interactive in the first place

Both agents are **collaborative**, not one-shot:
- **PA**: spec authoring is a conversation. The user has a fuzzy idea; PA pulls a `problem.md` out of them through Q&A, iterates on `success.md`, tweaks `constraints.md`, validates everything before handing off to the Solution Architect.
- **HA**: question-and-answer + permission-gated diagnostics. "Why didn't my loop run?" → HA reads logs, checks doctor, suggests a fix, asks permission to apply it.

These workflows take 10-60 minutes and involve dozens of back-and-forth turns. They're not buttons-and-forms; they're conversations. That's why both ship as Pattern A (system prompt injection + agent CLI takes over the user's terminal).

### Why the workload doesn't fit a non-trivial web UI well

- **Free-text input**: a chat box is the right shape. We'd be reinventing it client-side, then plumbing it server-side, then mediating to the agent CLI's stdio (or its newer streaming protocols).
- **Permission prompts**: when codex asks "may I edit `success.md`?" in the terminal, the user types `y`. From a browser, the same loop needs a modal, an event-bus round-trip, and an answer pushed back into the agent's stdin. Doable; not free.
- **Tool output**: when the agent runs `git status`, the output is rendered in the terminal. From the browser, we need to capture and pretty-print it.
- **Context-length awareness**: agent CLIs already handle compaction, model-routing, and rate-limit messaging. A bridge has to decide whether to surface those events or hide them.

Each of these is solvable. None is interesting. Together they constitute "rebuild the agent CLI's UX in a different medium" — the two-surface trap.

### Where cfcf's existing architecture *helps* if we ever go there

A surprise from the agent-CLI capability survey:
- **Claude Code** has `--input-format=stream-json` + `--output-format=stream-json` — full real-time event streams in/out, including hook events and partial messages. A bridge could speak this protocol instead of fighting raw stdio.
- **Codex** has `mcp-server` (Codex *as* an MCP server over stdio), experimental `app-server` + `exec-server`, and the TUI can `Connect the TUI to a remote app server websocket endpoint`.

So if we ever decided to build L4/L5, we wouldn't be inventing a wire protocol. The agent CLIs have already done that work — we'd just be building a chat client and a memory-aware orchestrator on top.

### Where cfcf's architecture *hurts*

- **Process model**: PA and HA today inherit the user's terminal stdio. Switching to a server-spawned agent process means the working directory, environment, and TTY context all need to be reproduced server-side. Doable, but it changes who "owns" the agent process — the user's terminal vs the cfcf server.
- **Memory ownership**: PA writes `.cfcf-pa/session-<id>.md` to the **user's repo working tree**. If the agent runs server-side, those writes happen on the server's view of the repo. For the same repo on the same machine, no issue. For a future remote-cfcf-server scenario (out of v1 scope but plausible), the assumption breaks.
- **Authentication**: any L3+ feature requires the web UI to authenticate to the cfcf server (currently localhost-only, no auth). Adding auth is its own design problem.

### The "small build" we actually want

Given all of the above, the realistic 5.15 deliverable is a small, additive enhancement that:
1. Lives at L1+L2 — better visibility, no new control surface.
2. Reuses what's there.
3. Doesn't lock in a future direction.
4. Solves real, observable user pain.

---

## 5. Options spectrum, costs, and recommendations

### Option A — Defer entirely (status quo)

Leave 5.15 unimplemented. PA stays at L0/L1, HA stays at L0.

- **Cost**: zero. Plan item closes as "decided not to."
- **Risk**: continued user confusion when running PA/HA — "is the web UI broken? Why is nothing showing up?"
- **When right**: if PA/HA usage is rare or the project pivots away from interactive agents.

### Option B — Small additive enhancements (recommended)

Pick a tight subset of L1+L2 work that materially improves observability without expanding the integration surface.

Candidate items (each independently scoped, none mandatory):

| # | Change | Cost | Value |
|---|---|---|---|
| B1 | **Add HA to History** as type `"ha-session"` (sessionId, startedAt, endedAt, optional summary if HA writes one). Mirrors what PA has at L0. | ~1 day. New type + history-event row + minimal detail panel. | HA stops being invisible. |
| B2 | **Surface PA's Clio writes** in the detail panel — show the Clio doc IDs + version numbers updated this session, with deep links to Clio. The data is already in `meta.json`. | ~half a day. Extend `PaSessionDetail.tsx` to render Clio-write summary + add `GET /api/clio/documents/:id` deep links. | "What did this session change?" answered in one click instead of a Clio search. |
| B3 | **Asciinema-style transcript** for PA and HA sessions. Wrap the agent spawn with a recorder (e.g., write `.cast` to `~/.cfcf/logs/<workspace>/pa-<sessionId>.cast`). Render with `asciinema-player` in the detail panel. | ~2 days. Wrap the launcher's Bun.spawn / spawnSync, ship the player JS, add an API endpoint that returns the cast file. | Replay exactly what happened — answers "what did the agent do" without me re-reading the scratchpad. Optional per-session via a config flag. |
| B4 | **Live "session active" indicator with elapsed time** in the workspace header (not just buried in History). Click → jump to active session. | ~half a day. Extend the existing Status tab logic to surface a top-of-page badge. | Small UX polish — confirms to the user "yes, the thing in your terminal is the same thing this UI is showing." |
| B5 | **HA "Help Assistant" button on each page** that **prints the command in a modal** (per the existing HA design doc). Doesn't launch HA — just shows the user `cfcf help assistant --workspace <name>` they need to copy + paste. | ~half a day. New modal component + one button per page. | Discoverability — users who don't read CHANGELOGs find HA. |

Total if all five: ~4-5 days of work. Recommend doing B1 + B2 first (highest ROI per hour), B3-B5 as time allows or in response to user pain.

### Option C — Build a "Help Assistant launch + structured Q&A" web feature (medium build)

Specifically for HA, which has a narrower workload than PA:
- HA queries are mostly Q&A. Many questions don't need an LLM at all — they need help-content lookup or a Clio search.
- A web "Help Assistant" panel could offer: full-text search over the embedded help bundle + Clio search over `cfcf-memory-ha`, with a fallback "ask the AI" button that prints the CLI command for the agent path.
- This is **L1+L2 for HA, plus a non-LLM L3-ish** retrieval path.

- **Cost**: 3-5 days. Needs help-content search API, Clio search UI, and a hybrid render.
- **Value**: a web user gets useful answers to ~60% of HA questions without ever launching an agent. The remaining 40% prompt them to copy-paste a CLI command.
- **When right**: if HA telemetry shows a high "I just asked one factual question" rate.

### Option D — Web terminal embed (xterm.js + PTY bridge)

Add a terminal pane to the web UI that can spawn `cfcf spec` or `cfcf help assistant`.

- **Cost**: 4-8 weeks initial build. Multi-week engineering tail forever. Security: localhost-bound + per-session token + opt-in via config flag.
- **Value**: real if the user works exclusively in the web UI; otherwise marginal.
- **When right**: if a future maintainer dogfoods cfcf entirely from a browser-on-iPad-or-Chromebook setup. Today: no one does.
- **Verdict**: **NOT recommended for v1 of 5.15.** Listed for completeness.

### Option E — Shadow chat (Jupyter pattern)

Web chat panel talks to the *same* agent process as the CLI, both as clients of a cfcf-server-mediated session.

- **Cost**: 3-6 months. Deep architectural change. Server now multiplexes agent sessions, both surfaces share session state, memory model needs revisit.
- **Value**: the only path that genuinely unifies CLI and web. Closest to the "right" answer for an AI-agent-orchestrator product if cfcf scales.
- **When right**: if cfcf grows past solo-dev usage and becomes a small-team product where some users live in the browser.
- **Verdict**: not for v1, not for v2. Track as a "if cfcf becomes a 5+ person team, revisit."

### Option F — Two-surface agent

Build a separate web-native PA/HA that shares memory.

- **Cost**: doubles maintenance.
- **Value**: marginal over Option E.
- **Verdict**: don't.

---

## 6. Recommendation

**Do Option B (the small additive bundle), specifically B1 + B2 + B5 as a first cut.** Defer B3 (asciinema) and B4 (live indicator) until those gaps are felt. **Defer C, D, E, F indefinitely.**

Why this combination:
- **B1** (HA in History): closes the most obvious gap. HA exists; the web UI should at least know that.
- **B2** (Clio writes in PA detail): maximises the value of work already done. The data is already there; we just don't render it.
- **B5** (HA launch button): closes the discoverability gap. Costs almost nothing.

This is ~2 days of work that meaningfully extends the existing L0/L1 coverage without committing the project to an interactive-in-browser direction.

If a future user asks "I want to drive PA from my browser," **revisit then**, not now. The agent CLIs (Codex `app-server`, Claude Code `stream-json`) have given us protocol surface that didn't exist a year ago, and that protocol surface will keep improving. Building L4/L5 against today's APIs would be a permanent maintenance commitment against a moving target.

---

## 7. Open questions deferred (record for the next round)

These don't need answers now but are worth capturing:

1. **Does PA need to write to Clio in real-time, or is end-of-session enough?** Today: end-of-session. If we ever want a "watch PA's thinking unfold" UI, real-time becomes the path of least resistance.
2. **Auth model when cfcf grows past localhost.** The web UI today assumes localhost = trusted. Any L3+ feature, and especially L4 (PTY bridge), forces this conversation.
3. **What does "remote cfcf server" look like?** Out of v1 scope, but PA's `.cfcf-pa/` working-tree assumption breaks under it. If we ever go there, the disk-cache layer needs revisiting.
4. **Should HA writes to Clio be visible from the web UI before HA itself is in History?** Probably yes, but only after B1 (HA in History) ships.

---

## 8. Decision

**Plan item 5.15 marked as researched. Proposed concrete v1 scope: Option B (B1 + B2 + B5).** Estimate ~2 days. Trigger: at maintainer's discretion, can land in iter-6 or be deferred further.

**Explicitly out of scope for v1 of 5.15:**
- xterm.js / PTY bridge / web terminal embed (Option D)
- Shadow-chat / Jupyter-pattern session sharing (Option E)
- Two-surface agent (Option F)
- Major Clio web-UI work beyond the deep links in B2

If/when the project's needs change (multi-user, remote server, browser-only contributors), re-open this doc and reconsider Options C–E in light of the agent CLIs' then-current protocol surface.
