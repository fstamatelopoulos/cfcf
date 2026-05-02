# cfcf Decisions Log

**Purpose:** Living record of every significant technical, architectural, and process decision made on the cfcf project. Consulted before making new decisions to avoid re-litigating settled questions. Updated every session.

**Format:** Reverse chronological. Each entry has:
- a date and short title,
- the **context** that prompted the decision,
- the **options considered** (where multiple were on the table),
- what was **decided**,
- the **outcome or lessons** (where applicable).

Entries describe *why we picked the path we did*, not *what shipped when* — the latter belongs in `CHANGELOG.md` and git history.

---

## 2026-05-02 — Post-6.25 UX iteration: history-row rendering, pause message wording, paused-state control-surface deduplication

**Context.** Three small UX gaps surfaced during the first round of dogfooding the structured pause actions (item 6.25, shipped via PR #27 a few hours earlier). Each was a discrete defect with its own root cause; together they're a useful study of "what kinds of things go wrong when you ship a feature that introduces a new event type + a new control surface." Captured as one entry because the lessons compound.

**The three defects (in order of how the user encountered them).**

1. **`loop-stopped` history rows rendered with empty Type / Agent / Result columns + a broken "log" button.** The new `loop-stopped` event type was added to core's `HistoryEventType`, but the web package has its **own** mirror of that type (in `packages/web/src/types.ts`) which wasn't updated. Result: the web's `typeLabel` switch fell through to `undefined`; `agentLabel` defaulted to the (now-undefined) `event.agent` and rendered empty; the result-column had no render branch for the new type; and the actions column fell through to a generic `[log]` button that called `onSelectLog({ logFile: undefined })` — broken click target. The root typecheck (`bun run typecheck` from the repo root) didn't catch the gap because it doesn't typecheck the web package; only `cd packages/web && bun run build` (which the local-install path triggers) caught the type mismatch downstream.

2. **The pre-loop pause message read as jargon.** *"Pre-loop review readiness=missing does not satisfy gate=needs_refinement_or_blocked. Edit the Problem Pack and resume."* The user's reaction — "ok, but not user-friendly" — captured the problem precisely: the message described the *gate-arithmetic* (which the user has to mentally translate back to "what does this mean for me?") rather than the *user's situation* and *what to do*. Replaced with a tailored plain-English message per case (review error / missing signal / verdict mismatch), mentioning concrete file paths (`problem-pack/problem.md` + `success.md`) and the resume-action alternatives (`Stop loop now`, `Refine plan`).

3. **Top-level Resume / Stop / Document buttons competed with the new structured FeedbackForm action panel during pause state.** Two control surfaces showing simultaneously, both routing to "resume." Worse, the legacy `Resume` button called `api.resumeLoop(workspaceId)` **without** the new `action` argument — defaulting server-side to `"continue"` and **bypassing the user's structured choice from the FeedbackForm**. This wasn't just visual clutter; it was a wrong-routing footgun. The fix was conditional rendering: hide all three legacy buttons when `phase === "paused"`. The FeedbackForm's 5-action panel becomes the single control surface during pause; legacy buttons reappear naturally on transition out of paused.

**Lessons.**

1. **A new event type or signal touches every consumer.** When `loop-stopped` was added to `HistoryEventType`, the natural assumption was "I added it to the type definition; everywhere using the type is auto-covered." Wrong: the web package has its **own** mirror of the type — not a shared import — so the addition was silently incomplete. **For any new enum value or event type, grep for the existing values across all packages and update each consumer.** The doc says they should be in sync; the type system can't enforce sync between two parallel definitions.

2. **The root `bun run typecheck` doesn't cover the web package.** Caught this when `local-install.sh` failed — the web package's `tsc -b && vite build` is stricter than root's `tsc --noEmit` and runs only when explicitly invoked (or transitively by the install script). **Future improvement** (already filed as a follow-up after the 0.16.5 SSOT version work): root typecheck should walk all packages, so the dev loop catches web type errors before manual builds. Until then: any change to shared types should run `cd packages/web && bun run build` as part of pre-commit smoke.

3. **Empty cells in a UI table = forgotten code path.** The `loop-stopped` row's empty Type / Agent / Result columns weren't a styling bug; they were "the switch fell through, the conditional render had no branch." Empty cells should be visually loud (they were silent here) — or, better, every renderable union member should have an exhaustive `switch` that TypeScript's never-check enforces. The row's broken "log" button is the same lesson: **action buttons should check their data exists before rendering**, not assume the dispatcher will handle a missing target gracefully.

4. **A new control surface needs an audit of existing surfaces it competes with.** The structured FeedbackForm was added without checking whether the LoopControls (top-level buttons) were going to render simultaneously. Both rendered correctly *in isolation*; together they created a wrong-routing path because the legacy Resume call didn't pass the new `action` parameter. **When you add a new control surface, audit every existing surface that's reachable in the same app state for overlap.** Hide or update the old surface; don't leave both visible.

5. **"Pause message wording" is a recurring failure mode.** The earlier "fix" had used gate-arithmetic phrasing ("readiness=missing does not satisfy gate=..."). That phrasing worked for an engineer reading the code; it didn't work for a user reading a UI prompt. **Pause messages should describe the user's situation + what to do, not the harness's internal state machine.** Future auto-generated pause messages should be reviewed against this lens.

**Outcome.** All three fixes shipped in this branch (`fix/loop-stopped-history-render`) with no test regressions. UX is meaningfully cleaner: history rows render with full info, pause messages read in plain English, the FeedbackForm is the single source of action during pause.

**Cross-refs.**
- Commits: `c30cf1d` (loop-stopped + pause message), `d1017ee` (hide legacy buttons), `bd0bb92` (SCOPE_COMPLETE — separate entry below).
- Affected files: `packages/web/src/types.ts`, `packages/web/src/components/{WorkspaceHistory,FeedbackForm,LoopControls}.tsx`, `packages/web/src/pages/WorkspaceDetail.tsx`, `packages/core/src/iteration-loop.ts:buildPreLoopBlockReason`.

---

## 2026-05-02 — Architect SCOPE_COMPLETE readiness verdict + holistic agent-signal audit

**Context.** Two days into dogfooding the structured pause actions (item 6.25), a follow-up gap surfaced when the user re-ran the loop on the calc workspace (whose 4 iterations had completed days earlier). The Solution Architect correctly observed *"No new product-scope gaps: the current problem pack's power operation is already implemented and tested in source"* — but had to express this through `readiness: NEEDS_REFINEMENT` because the existing 3-value enum (`READY` / `NEEDS_REFINEMENT` / `BLOCKED`) had no way to say "spec is fine but there's no work to do." The user's "fix the spec" mental model from the misleading verdict competed with the architect's actual analysis ("the scope is done").

This is the **same vocabulary-conflation pattern** as the 2026-05-02 structured-pause-actions entry above: when a single signal is overloaded across orthogonal axes (here: spec-quality vs work-remaining), the harness silently misroutes the agent's actual intent. Different enum, same anti-pattern.

**Decided.** Add `SCOPE_COMPLETE` to `ArchitectReadiness`:

- Always blocks the loop regardless of `readinessGate` setting (no semantic where "proceed despite no work" makes sense; the gate's "tolerate spec issues and run anyway" semantic doesn't apply when there's no work).
- Pauses with a dedicated `pauseReason: "scope_complete"` (not `"anomaly"` — this is a positive outcome, not a problem state).
- Available actions narrow to `finish_loop` / `stop_loop_now` / `refine_plan` (hides `continue` — nothing to build — and `consult_reflection` — no iterations to reflect on).
- Distinct UI rendering: `readinessColor: var(--color-info)` (neutral), dedicated `architect-review` guidance text, `pauseReasonTitle: "Loop paused: scope already complete"`.

**Naming**: `SCOPE_COMPLETE` chosen over `NOTHING_TO_DO` / `ALREADY_DONE` / `IMPLEMENTATION_COMPLETE`. Mirrors the architect's own language ("no new product-scope gaps"); reads naturally in the UI ("Architect rated this `SCOPE_COMPLETE`"); distinguishes clearly from `judge.determination === "SUCCESS"` (which means "the loop ran successfully") — `SCOPE_COMPLETE` means "the loop never started because there was nothing to do."

**Holistic agent-signal audit.** Triggered by the same vocabulary-conflation lesson, audited every agent's signal vocabulary against real-world cases to identify other gaps. **Outcome: only the architect needed extending.** Other roles either compose existing signals naturally or have orthogonal coverage:

| Role | Signal vocabulary | Verdict |
|---|---|---|
| **Architect** | `readiness`: 3 values | **Gap fixed**: added `SCOPE_COMPLETE` |
| **Dev** | `status`: completed / partial / blocked + tests + self_assessment + blockers | Sufficient. The "nothing to do mid-loop" case (e.g. iter-N over-delivers and consumes iter-N+1's plan items) is caught downstream by judge's `anomaly_type: "no_changes"` — semantically accurate enough; no new dev signal warranted by current usage. |
| **Judge** | 4 determinations + 5 anomaly_types + reflection_needed/reason | Sufficient. The 5 anomaly types (`token_exhaustion` / `user_input_needed` / `circling` / `no_changes` / `regression`) cover the long tail of iteration outcomes. SCOPE_COMPLETE-equivalent at iteration time = `anomaly_type: "no_changes"` + `should_continue: false` + `key_concern` explanation. |
| **Reflection** | 5 iteration_health values + `recommend_stop` + `harness_action_recommendation` | Sufficient. The earlier 2026-05-01 fix already added iteration_health-based disambiguation; SCOPE_COMPLETE-equivalent at reflection time = `recommend_stop: true` + `iteration_health: "converging"`. |
| **PA** | Free-form `outcomeSummary` + `decisionsCount` + `clioWorkspaceMemoryDocId` | N/A. PA is conversational by design — no structured-determination enum. Free text expresses any outcome. |

**Lessons.**

1. **The vocabulary-conflation anti-pattern recurs naturally.** First instance: `recommend_stop=true` overloaded across stuck/done/disagree (2026-05-02 entry above). Second instance: `readiness` overloaded across spec-quality and work-remaining (this entry). Both fixes were "split the conflated axis." Worth watching for in any future signal additions: **if one signal field has to express two orthogonal axes, the consumer will silently misroute one of them.**

2. **Audit before assuming symmetry.** When the user asked "now that we've added a new state to the architect, should we add it to other roles too for consistency?" — the natural temptation was to mechanically add SCOPE_COMPLETE everywhere. The right answer was an honest analysis: *only the architect was missing it; other roles already have sufficient expressivity through different mechanisms.* Symmetry-for-symmetry's-sake is the failure mode I previously called out in the structured-pause-actions discussion (PA + HA per-workspace overrides). Same lesson applies to signal vocabulary.

3. **The "always blocks regardless of gate" semantic is the right shape for terminal-positive states.** SCOPE_COMPLETE is functionally a terminal state (loop has nowhere to go), but it's a *positive* terminal — not a failure. The gate's tolerance semantic ("yes, run anyway") only makes sense when there's *something to run*; for "no work" it doesn't apply at all. Future agent-signal extensions in the "loop already done somehow" space should follow this pattern: hard-block, dedicated pauseReason, dedicated narrowed action set.

4. **A new signal value forces a checklist of touchpoints.** For `SCOPE_COMPLETE`: type extension, gate logic, pause-reason, allowed-actions matrix, UI color, UI guidance text, agent prompt, tests across all of those, decisions-log entry. ~9 surfaces touched. Captured here so the next maintainer adding a signal value has a checklist to follow rather than hunting for affected sites by grep.

**Outcome.** SCOPE_COMPLETE shipped end-to-end on `fix/loop-stopped-history-render` (commits TBD on push). 12 new unit tests. CHANGELOG + workflow.md updated. Per-role audit findings captured in this entry — confirms that no further signal additions are needed at this time; future signal expansions must justify against the conflation-anti-pattern lens.

**Cross-refs.**
- Architect prompt extension: `packages/core/src/templates/cfcf-architect-instructions.md`
- Type: `packages/core/src/types.ts` (`ArchitectReadiness` enum)
- Harness logic: `packages/core/src/architect-runner.ts:readinessGateBlocks` + `packages/core/src/iteration-loop.ts:buildPreLoopBlockReason` + `pauseReasonAllowedActions`
- UI: `packages/web/src/components/ArchitectReview.tsx` (readinessMeta) + `packages/web/src/components/WorkspaceHistory.tsx` (readinessColor) + `packages/web/src/components/FeedbackForm.tsx` (action matrix)
- Tests: `packages/core/src/iteration-loop.test.ts` (12 new tests covering `readinessGateBlocks`, `buildPreLoopBlockReason`, `pauseReasonAllowedActions` for SCOPE_COMPLETE)

---

## 2026-05-02 — Structured pause actions: ResumeAction enum + iteration_health discrimination + reflection consult mode

**Context.** Two related bugs surfaced during dogfooding the tracker workspace on 2026-05-01:

1. **Reflection-on-SUCCESS misroute**: iter-5 ended with judge SUCCESS (9/10, 20/20 tests, plan 100% complete). The `reflectSafeguardAfter=3` ceiling forced reflection even though `reflection_needed: false`. Reflection honestly observed "loop has nothing left to do" and set `recommend_stop: true`. The harness saw `recommend_stop=true` and surfaced a "Questions needing your input" popup — a false alarm, because reflection AGREED with SUCCESS rather than flagging a problem.

2. **Free-text feedback misroute**: user typed *"Judge and Reflection agree, proceed to the Documentation phase and close the loop"* into the popup. The harness's resume contract had **one input channel** (textarea) and **one output behavior** (continue with the text injected into the next dev agent's prompt as "guidance"). The user's clear *control intent* was silently rerouted as *agent context* — fired iter-6, dev agent got confused user feedback that didn't match the iteration it was running.

Both bugs traced to the same root cause: the harness's pause-resume contract had **insufficient signal vocabulary** to express user intent. `recommend_stop=true` was overloaded across three meanings ("stuck" / "done, agree" / "supposedly done, disagree"); the `feedback` string was overloaded across "context for next agent" / "instructions for harness" / "audit note." When semantics are conflated into one channel, the harness has no choice but to pick one default routing — silently misrouting all the others.

**Options considered.**

1. **Just dismiss the false-alarm popup; accept the noise.** Cheapest. Rejected: the popup creates anxiety (*"did I do something wrong?"*) at exactly the moment of celebration (loop succeeded). Triggers any time `reflectSafeguardAfter` cycles complete on a SUCCESS iteration — non-rare in practice.

2. **Skip reflection entirely on SUCCESS iterations.** Eliminates the problem class but loses real audit/safeguard value: reflection's cross-iteration view occasionally catches nuance the single-iteration judge misses. The user explicitly pushed back on this option; correctly.

3. **Disambiguate `recommend_stop=true` via `iteration_health`** — already-existing reflection signal field with semantically distinct values (`converging`/`stable` = agreement; `stalled`/`diverging`/`inconclusive` = disagreement). Shipped first as a small fix (PR #26, 889127a, 2026-05-01).

4. **Generalize: introduce a structured `ResumeAction` enum** so all 9 pause cases get the same routing precision, not just reflection-on-SUCCESS. Free text stays optional + routes per action to the right destination. Shipped second as the bigger feature (PR #29, item 6.25, 2026-05-02). Full design in [`docs/research/structured-pause-actions-design.md`](research/structured-pause-actions-design.md).

**Decided** — ship both fixes (3 + 4). They're complementary:

- The `iteration_health` discrimination is the *minimal* fix for the specific tracker case; required regardless of the bigger framework.
- The `ResumeAction` enum is the *general* solution for the pause-resume contract across all cases. Without it, every pause case has the same "single textarea silently routes one way" failure mode.

**Specific design choices for `ResumeAction`:**

- Five actions, no more: `continue`, `finish_loop`, `stop_loop_now`, `refine_plan`, `consult_reflection`. Empirically covers the universe per the [matrix in the design doc](research/structured-pause-actions-design.md). Adding a sixth would mean the matrix grew a column; we've staffed it for one human-decision step at a time.
- **`finish_loop` vs `stop_loop_now`** chosen over `stop_and_document` vs `stop` (initial naming). Clearer framing: "honour the configured loop end-state" vs "explicit immediate termination." `finish_loop` respects `autoDocumenter=false`; `stop_loop_now` always skips the documenter.
- **`consult_reflection` as the escape hatch.** When the user has nuanced free-text intent that doesn't map to a button, route through reflection — it has the cross-iteration view + already outputs structured signals. New field `harness_action_recommendation` lets reflection tell the harness what to do. Cheaper + cleaner than a separate "interpreter agent."
- **No bare "Resume" button.** User must explicitly pick an action. Forces clarity; eliminates silent defaults. Mirrored in CLI: `cfcf resume --action <name>` (defaults to `continue` for back-compat with pre-6.25 scripts only).
- **Free text always optional + always routed.** Per the [routing table](research/structured-pause-actions-design.md), text goes to the right destination per action: dev prompt for `continue`, documenter prompt for `finish_loop`, history audit for `stop_loop_now`, architect prompt for `refine_plan`, reflection prompt for `consult_reflection`. Never silently lost; never silently misrouted.
- **Per-pause-case applicability matrix** computed by `pauseReasonAllowedActions()`, single source of truth for both UI button visibility AND CLI argument validation. The two surfaces stay in sync because they consume the same helper.
- **`refine_plan` flow**: synchronous architect spawn → automatic continue. No mid-flow re-pause (avoids pause-loops). Architect's existing `plan-validation.ts` guardrails catch destructive rewrites.
- **`stop_loop_now` history note**: dual-write — structured `loop-stopped` event in `history.json` (machine-readable) + human-readable narrative paragraph in `iteration-history.md`. Two surfaces; one truth.
- **`consult_reflection` after A6** (reflection just ran with `recommend_stop=true`): allowed. Re-spawn reflection with the user's new feedback as fresh input. Full flexibility; cost is one extra agent run.

**Lessons.**

1. **When semantics are conflated into one channel, the harness silently misroutes.** This was the meta-pattern across both bugs. `recommend_stop` was a single boolean expressing three things; `feedback` was a single string expressing three things. Once we explicitly separated control-intent (action) from context (free text), every pause case routed correctly without per-case heuristics. **The fix is in the protocol vocabulary, not in the harness logic.**

2. **Defense-in-depth: signals-as-contract is the right design even when agents misbehave.** The reflection-on-SUCCESS bug only mattered because the agent did its job correctly (wrote good signals + a thorough analysis) but the harness misinterpreted. Both fixes preserve the "files are the contract; agents are producers" invariant established in 5.6 (reflection PR1). Any future signal vocabulary expansion (this entry) reinforces rather than weakens it.

3. **Symmetry is a misleading argument.** Reflection-PR-discussion gave us "reflection runs every iteration → per-workspace override useful" → *therefore by symmetry* PA + HA should also be per-workspace overridable. Wrong: the workload structures differ, and symmetry is a UI-tidiness argument, not a design argument. Same lesson applies in reverse: just because reflection-on-PROGRESS pauses make sense doesn't mean reflection-on-SUCCESS pauses do (different scenarios despite similar signals). **Look at the actual workload, not the surface symmetry.**

4. **The user's free-text feedback is precious — never silently drop it.** Even when no agent runs (e.g. `stop_loop_now`), capture the text to history as audit. Future debugging + retrospectives benefit from "what was the user thinking when they did this?" Free text without a destination is data leak; free text routed to *somewhere* is always useful.

5. **The escape hatch is a feature, not a fallback.** `consult_reflection` doesn't exist because we couldn't enumerate the long-tail; it exists because the LLM-interpreter pattern is genuinely the right tool for "the user's intent is nuanced and I have an agent that's good at interpretation." Building it as a first-class action (rather than as a "Layer 2 fallback when buttons are too restrictive") makes the design honest about what each component is for.

**Outcome.** Item 6.25 ships with full per-pause-case action routing, contextual UI button matrix, CLI `--action` flag with matrix validation, reflection consult mode, and `stop_loop_now` audit history. Both fixes (small `iteration_health` discrimination + general `ResumeAction` enum) cover the bug class end-to-end. ~580 tests passing.

**Cross-refs.**
- [`docs/research/structured-pause-actions-design.md`](research/structured-pause-actions-design.md) — full design + matrix
- [`docs/plan.md`](plan.md) row 6.25
- 2026-05-01 reflection-on-SUCCESS fix (commit 889127a, PR #26): `iteration_health` discrimination via the pre-existing signal field

---

## 2026-05-01 — npm publish auth: OIDC trusted publishing + sigstore provenance (bootstrapped via a one-shot token)

**Context.** v0.16.2 was cfcf's first publish to npmjs.com, after the 2026-04-30 public-flip. The publish needed to work the first time with whatever auth path was simplest to bootstrap; subsequent publishes wanted the strongest supply-chain posture npm offers. Two distinct decisions, one workflow.

**Decided — bootstrap path (v0.16.2 only).** Manual `npm publish` from CI using a granular npm access token scoped to `@cerefox/codefactory*`, stored as `NPM_TOKEN` in the repo's GitHub Secrets. The token was created with the **bypass-2FA** option enabled — required because `npm publish` from a non-interactive CI runner can't satisfy a 2FA-via-authenticator-app check. Token was used for v0.16.2's publish and **revoked the same day**.

**Decided — durable path (v0.16.3 onwards).** Switch to **OIDC trusted publishing** via npm's GitHub Actions integration:
- Each of the 4 `@cerefox/codefactory*` packages has a Trusted Publisher entry on npmjs.com pointing at this exact repo (`fstamatelopoulos/cfcf`) + workflow (`release.yml`).
- The `npm-publish` job declares `permissions: id-token: write`, mints a short-lived OIDC token per workflow run, and `npm publish` validates against the registered trust before publishing. No long-lived secret anywhere in the repo.
- All 4 packages have publishing access tightened to "Require two-factor authentication and disallow tokens (recommended)" — the most restrictive supply-chain posture npm offers when combined with OIDC.
- Workflow uses Node 22 + `npm install -g npm@latest` to ensure npm CLI ≥ 11.5.1 (the minimum Trusted Publishing requirement; Node 22 ships with npm 10.x). A pre-flight version check fails fast with a clear error if the install drops below 11.5.
- `--provenance` flag added to all `npm publish` calls. Each tarball ships with a sigstore-signed attestation linking it to the exact GitHub Actions run that built it, surfaced as a "Provenance" badge on npmjs.com.

**Why two-step instead of OIDC from day one.** OIDC trusted publishers can only be registered against an existing package + a real workflow run that's already published it. You can't register a Trusted Publisher for a package that doesn't exist yet — npm has nothing to bind the trust against. A bootstrap publish using something else is required. The bypass-2FA token + same-day revocation is the recognised pattern (npm's docs walk through it explicitly). Once v0.16.2 was on npm, registering OIDC against the workflow + future-proofing every subsequent publish was a 5-minute UI step per package.

**Outcome.** Only `release.yml` on `fstamatelopoulos/cfcf`, manually triggered via `workflow_dispatch` with `publish_to_npm=true`, can publish new versions of these 4 packages. The repo holds no long-lived publish secret. All v0.16.3+ tarballs carry a sigstore provenance attestation visible on the package's npmjs.com page.

**Lessons.**

1. **Plan auth in two phases when starting a new package.** OIDC's chicken-and-egg means day 1 needs a different path. Designing for the durable end state from day 1 saves you from leaving a long-lived token in CI "just in case".

2. **Revoke bootstrap credentials the same day**, even if you're "definitely going to switch tomorrow". Tokens that linger past their stated lifetime are how supply-chain incidents start.

3. **Provenance attestation is free with OIDC**, costs one CLI flag, and gives users a visible signal that the artefact came from the repo it claims to. Worth turning on for every package that supports it.

---

## 2026-04-30 — Going public on GitHub: pre-flight sweep + naming + Apache-2.0

**Context.** Prerequisite for npm OIDC trusted publishing (which requires a public repo on the free tier) and for the broader 5.5b "publish to npmjs.com" milestone. The repo had been private since inception (~351 commits, 4.43 MB of history including design notes, dogfood logs, and a Cerefox-internal phase). Flipping to public is one-way; needed a clean security/privacy sweep first.

**Decided — pre-flight sweep before flipping the visibility switch.**

- **Secrets scan**: `gitleaks detect` against the full git history. Returned 0 findings.
- **`.env*` audit**: confirmed no `.env*` files anywhere in history.
- **Personal-info audit**: no private keys, API tokens, phone numbers, physical addresses, or Cerefox-internal URLs in any commit, doc, or config.
- **Author-metadata acceptance**: two emails on git author metadata + author name on 4 design docs — these are intentional and accepted (the project is publicly attributed to its author).
- **`SECURITY.md` + `CONTRIBUTING.md`** added at repo root before flipping (vuln reporting flow + contribution guide).
- **`LICENSE`** at repo root: switched the published packages' license from `UNLICENSED` to **Apache-2.0** to match the rest of the Cerefox ecosystem.

**Decided — npm package naming for 5.5b.**

- npm package name = **`@cerefox/codefactory`** (reads cleanly in install instructions; future-proofs the `@cerefox` scope for sibling packages). Was `@cerefox/cfcf-cli` pre-publish.
- Per-platform native packages = `@cerefox/codefactory-native-<platform>` (was `@cerefox/cfcf-native-*`).
- **CLI binary stays `cfcf`** — typing-friendly, users invoke 100x/day. No multi-bin aliases (cause cross-platform headaches without enough payoff).
- **Legacy `@cerefox/cfcf-*` resolution fallback removed** from `constants.ts` / `clio/db.ts` / `doctor.ts` — a hard cut so the legacy name can never silently take effect at runtime (security: prevents a hypothetical attacker from squatting the legacy name).

**Decided — `os`/`cpu` declared on the main package itself**, not just the per-platform native ones (`"os": ["darwin", "linux"]` + `"cpu": ["arm64", "x64"]`). So a Windows-native or FreeBSD user running `npm install -g @cerefox/codefactory` gets a fast, loud `EBADPLATFORM` at install time instead of silent success without the matching native package + a runtime crash on first run. `cfcf doctor`'s libsqlite3 check stays as second line of defense.

**Decided — cross-compile darwin-x64 on macos-14**, not on macos-13. The macos-13 (Intel) runner pool became unviable for free-tier public repos (multi-hour queues during the public-flip window). `clang -arch x86_64` on the macos-14 (arm64) runner produces a working darwin-x64 binary; validated by reverse-direction testing on a real Intel Mac.

**Outcome.** Repo public on 2026-04-30. v0.16.2 published to npmjs.com same day with the bypass-2FA bootstrap token (see 2026-05-01 decision-log entry on publish auth).

**Lessons.**

1. **The cross-compile direction matters.** macos-14 → darwin-x64 cross-compile works; macos-13 → darwin-arm64 is the historical baseline but the runner pool is constrained. Test the direction you can actually run in CI before you commit to it.

2. **Hard-cut legacy package-name fallbacks before going public.** A legacy resolution path is a foot-gun the moment your package-name is on a public registry where anyone can squat the old name.

3. **Loud install-time failure beats silent runtime crash.** `os`/`cpu` on the parent package is the difference between "this OS isn't supported" at `npm install` time versus a SQLite-not-found stack trace 20 minutes into a user's first session.

---

## 2026-05-01 — Install cfcf into `~/.bun` via `npm install -g --prefix ~/.bun` (zero-friction install)

**Context.** v0.16.2 shipped cfcf to npmjs.com. The next obvious task: a curl-bash one-liner so a random user lands on the GitHub repo, pastes one line, and gets a working cfcf. Multiple iterations between 2026-04-30 and 2026-05-01 tested four distinct install-tool strategies on two real Macs (Intel + Apple Silicon, both with prior cfcf in various states). Each design that "looked right on paper" surfaced a real-world UX problem that ruled it out. Capturing the full journey here so we don't re-litigate.

**The hard constraint.** `install.sh` runs as a child process of the user's shell (`curl ... | bash` spawns `bash` as a child). **A child process cannot modify its parent's environment** — Unix process model. Any `export PATH=...` in install.sh affects only install.sh's subshell; when install.sh exits, the parent shell's PATH is unchanged. Any rc-file edit only takes effect on next shell startup or `source ~/.zshrc`. Every modern shell-based installer hits this wall (Bun's official installer, rustup, nvm, Volta, Homebrew); they all print "open a new terminal" when they have to add new PATH entries.

The corollary: the BEST install.sh can do is **install cfcf into a directory that's already on the user's PATH**, so no new PATH entry is needed. If we have to add a new entry, we MUST tell the user to source-rc / open new terminal once.

**Options considered (chronological, with what each tested + ruled out).**

1. **`bun install -g @cerefox/codefactory`** (the v0.16.3 baseline). Single tool. ~/.bun/bin always user-writable; PATH already set up by Bun's installer. Worked structurally **but** Bun blocks postinstall scripts of transitive deps by default ([oven-sh/bun#4959](https://github.com/oven-sh/bun/issues/4959)). cfcf depends on `onnxruntime-node` (downloads platform-specific .node binaries) + `protobufjs` (codegen) — without those running, Clio's embedder breaks at runtime. cfcf's published `package.json` declares `trustedDependencies: ["onnxruntime-node", "protobufjs"]`, but bun's transitive-trust handling for `-g` installs is incomplete. User-facing fix: manual `bun pm -g trust @cerefox/codefactory onnxruntime-node protobufjs`. **Ruled out for new users**: the trust-prompt UX is exactly the "click yes to a security alert" pattern that erodes first-impression trust on an unknown CLI.

2. **`bun install -g` + scripted auto-trust in install.sh**. install.sh runs the trust grant for the user, named (not `--all`), with verbose output. Implemented + tested. Worked end-to-end. **Ruled out**: even with named packages + auditable output, the visible `bun pm -g trust` line in the install output raised "what is this approving?" concerns. "I want to avoid asking a user that is a miracle that they showed interest to an unknown app to just 'trust' something." Engineering simplicity (single tool, ~120 line install.sh) didn't justify the new-user-UX cost.

3. **`npm install -g @cerefox/codefactory`** (npm runs postinstalls by default — no trust step needed). Implemented + tested on the Apple Silicon Mac. **Hit the EACCES gotcha**: stock-installer Node (the official `.pkg` from nodejs.org) sets npm's global prefix to `/usr/local/`, root-owned. `npm install -g` fails without sudo. The npm-documented fix is `npm config set prefix ~/.npm-global` + `export PATH="$HOME/.npm-global/bin:$PATH"` in shell rc — what `nvm`/`fnm`/`asdf` do automatically. **Worked but added complexity**: install.sh needs to detect the EACCES condition, set up `~/.npm-global`, write to shell rc; ~280 lines instead of ~120; user gets "IMPORTANT: open new terminal" friction every fresh install (parent shell can't see the new ~/.npm-global/bin until rc is re-sourced).

4. **`npm install -g --prefix ~/.bun @cerefox/codefactory`** — the winning design. cfcf installs to `~/.bun/bin/cfcf`. Since cfcf REQUIRES Bun (uses `bun:sqlite`, `Bun.spawn`, etc. directly at runtime), every cfcf user has Bun. Bun's installer adds `~/.bun/bin` to the shell rc when bun is installed. So `~/.bun/bin` is on the user's PATH, and cfcf is reachable immediately — **no new PATH entry, no rc edit by cfcf, no source-rc step**.

**Decided** — option 4. Specifically:

- `scripts/install.sh`: bootstrap Bun if missing; bootstrap npm if missing (`bun install -g npm`); run `npm install -g --prefix ~/.bun @cerefox/codefactory`; print "Installation complete!" banner.
- `scripts/uninstall.sh`: detect cfcf at any of the historical install locations (~/.bun/lib/node_modules, ~/.npm-global/lib/node_modules, npm system prefix /lib/node_modules, ~/.bun/install/global/node_modules) and clean each up via the right tool.
- `packages/cli/src/commands/self-update.ts`: same `npm install -g --prefix ~/.bun` for upgrades.
- The `--prefix ~/.bun` flag is per-command; doesn't touch user's npm config (their other `npm install -g` operations keep using their default prefix).
- Bun is cfcf's RUNTIME (via the runtime APIs); npm is cfcf's INSTALL TOOL (because of bun#4959). Two tools, clean separation. install.sh handles both bootstraps transparently.

**Friction cases under option 4:**

| User profile | Friction |
|---|---|
| Already has Bun installed (the realistic cfcf user) | **None.** cfcf at ~/.bun/bin/cfcf, immediately on PATH. `cfcf init` works in same terminal. |
| Doesn't have Bun yet | One-time "open new terminal" or `source ~/.zshrc` after install.sh — same step `curl bun.sh/install \| bash` requires regardless of cfcf. install.sh detects this state via `ORIGINAL_PATH` and prints an "IMPORTANT" banner block. |

**Trade-offs accepted:**

- cfcf lives in `~/.bun/lib/node_modules/` alongside Bun's own globals. Cosmetic; functionally fine. cfcf is the only binary so no `~/.bun/bin/` namespace conflict.
- `--prefix ~/.bun` is a non-standard npm invocation pattern. Documented clearly + consistent across install.sh, self-update, and the docs' "direct install" examples.
- uninstall.sh has to know to use `--prefix ~/.bun` too. Done; also detects 3 other historical install locations for cleanliness.

**What a "fully zero-friction-always" install would require (and why we can't have it):**

A generic-user one-liner that works perfectly on EVERY machine WITHOUT ever needing the user to do anything afterwards is **not achievable** under the Unix process model. install.sh's subshell can't reach into the parent shell. For users brand-new to Bun, Bun's installer must add `~/.bun/bin` to their rc, and their current shell must source it once. This is a one-time step Bun's official installer also requires; cfcf doesn't add new friction beyond what Bun itself imposes. The bun-prefix design collapses cfcf-specific friction to **zero** for the realistic cfcf user (someone with Bun already).

**Lessons.**

1. **Test on real machines, not on the dev machine.** Every iteration's "works on my machine" failed on a fresh machine in a different way. Three distinct end-to-end failures (postinstall blocking, EACCES, parent-shell-PATH not picked up) were all surfaced by clean-machine tests, not by the dev environment.

2. **Lean on the user's existing tooling instead of adding new toolchain.** The breakthrough (option 4) was realizing cfcf already requires Bun, so Bun's PATH entry is "free" for us to use. We were trying to install into a NEW directory and add a NEW PATH entry, then fight the parent-shell-can't-be-modified problem. Installing into the EXISTING bun directory uses the EXISTING PATH and side-steps the constraint entirely.

3. **The "(but I hear you about the existing solution)" turn is worth pursuing.** The user explicitly accepted option 2 (bun-only with auto-trust) but flagged residual concern. Re-examining the priorities — "standard JS-ecosystem path", "no allow commands in output" — surfaced npm as the better fit, leading to options 3 then 4. Following the user's reaffirmed priorities even after agreement is more valuable than treating "agreement" as the end of the discussion.

4. **Write up failed designs in the decision log too**, so the next maintainer (or LLM agent) doesn't try them again. The four-option rationale here is the durable artifact; the v0.16.4 CHANGELOG entry only describes what shipped.

**Outcome.** v0.16.4 ships option 4. Both fresh-Mac tests pass on first install with no follow-up steps. Updated install.sh + uninstall.sh + self-update.ts + the README + installing.md + troubleshooting.md + the per-release `INSTALL.md` asset all use `--prefix ~/.bun`.

---

## 2026-04-29 — Codex `failed to record rollout items: thread ... not found` is benign telemetry noise; we don't filter it

**Context.** Dogfood on the `cfcf-calc` workspace surfaced an entry in the documenter's stderr log:

```
failed to record rollout items: thread <UUID> not found
```

The documenter completed successfully, committed the docs, and the project's tests + typecheck passed. But the warning is loud + alarming-sounding — Product Architect flagged it during a post-loop review, and a reasonable user would too. Question: **is this a cfcf bug we should fix, a codex bug we should report, or noise we should filter?**

**Investigation.**

The message comes from codex's **own internal rollout/session ledger** — the system codex uses to track agent threads + tool-use turns for its own observability + history features. Specifically:

- Codex tags every interactive session with a `thread` UUID at startup.
- During a session, codex periodically writes "rollout items" (tool calls, agent turns, etc.) to its rollout ledger, keyed by `thread`.
- If the registration of the thread itself failed silently (or the thread ID got out of sync with the ledger's expectations), subsequent rollout writes can't find it → the warning fires.

The warning appears specifically under our cfcf launchers because:

- Both PA + iteration-time agents run codex with non-default `-c sandbox_mode=...` and `-c approval_policy=...` overrides
- The combination occasionally trips codex's thread-registration path (the precise interaction is internal to codex; we have no API to inspect it)
- The agent's actual work — bash tool calls, file edits, conversation turns — completes normally regardless. Only codex's internal session-history bookkeeping is affected.

**Decided** — leave it alone. We don't filter, we don't redact, we don't report upstream until/unless something concrete changes:

- It's a codex-internal warning, not an error our agents emit. Filtering it from the captured log would amount to **silently hiding output codex itself produced** — that's the wrong default. Users who can read the log can read it accurately; future codex updates may make the warning useful diagnostic info (or remove it entirely).
- It's not a functional failure. The agent's outputs (commits, signals, files) are unaffected. Filtering would risk masking a future REAL codex error of the same shape.
- It's not consistent enough to fingerprint reliably — the exact wording could shift across codex versions, and we don't want to maintain a regex-based denylist.
- We don't have a clean upstream report to file. "Codex's rollout ledger drops thread registrations under non-default sandbox modes sometimes" is hard to reproduce on demand + the agent works correctly anyway. We'd need a deterministic repro before filing.

**What WOULD change our mind:**

- If the warning ever co-occurs with actual cfcf-visible breakage (agent failures, signal-file corruption, missing commits, etc.) → we investigate as a real bug and likely file upstream.
- If codex documents an opt-out config (e.g. `-c rollout_telemetry=off`) → we flip it for cfcf launches to keep the log clean.
- If the warning's wording/shape stabilises across codex versions and we could reliably filter it without false-positive risk → we revisit the filter decision.

**Lessons.**

1. **"This warning is loud, but harmless" is a real category.** Don't assume every alarming string in a captured log is a bug. Trace where it came from + what it's about before acting. Codex's stderr ≠ cfcf's stderr.
2. **Distinguish "agent's own logs" from "harness's diagnostics".** cfcf captures everything the agent CLI emits; some of it is the agent's internal noise, not domain output. Filtering should be opt-in by the user (a future `--quiet` or per-line filter), not unilateral.
3. **PR descriptions are a good place to record "we considered X and dismissed it".** When a reviewer or future-you re-encounters the warning, the bug-fix PR's body explains why bug 2 wasn't addressed alongside bug 1. This decisions-log entry promotes that explanation to a more durable home.

**Outcome.** No code change in cfcf. Future readers who hit this warning + grep the docs will land here.

---

## 2026-04-29 — Embed the full cfcf docs into interactive role agents' system prompts

**Context.** cfcf has two interactive roles: Help Assistant (HA, `cfcf help assistant`) and Product Architect (PA, `cfcf spec`). Both run the user's configured agent CLI (claude-code or codex) in interactive mode and ask the agent to behave as a domain expert in cfcf — answering "how does the loop work?" / drafting Problem Pack files / explaining Clio retrieval / etc. The conventional approaches for "make an agent expert in a domain" are: fine-tuning, RAG, or a custom agent built from scratch. None of those are appropriate for cfcf — fine-tuning needs training data + ongoing maintenance, RAG needs a retrieval index + chunking pipeline, custom agent abandons our adapter-agnostic promise.

**The "breakthrough" we landed on.** Just **embed the full cfcf documentation bundle (~160 KB) directly into the agent's system prompt at launch.** No fine-tuning. No RAG. No custom agent. cfcf assembles the prompt as: role-specific framing + state injection + memory inventory + **every help topic from `docs/guides/*.md` and `docs/api/server-api.md`** + closing instructions. Total prompt: ~170-180 KB. The agent CLI (claude-code: `--append-system-prompt`; codex: `model_instructions_file` tempfile) accepts the full string as the agent's system context.

Modern context windows make this trivial:
- Sonnet 4.6 / Opus 4.7: 200K tokens (~800 KB plain text)
- GPT-5 / o3: similarly generous
- Even at 180 KB system prompt, the user's conversation has 600+ KB headroom

**Why this works in practice (validated by dogfood, 2026-04-29):**

1. **Modern LLMs read + cross-reference long contexts well.** The agent doesn't need a retrieval step — it can answer "what does `cfcf reflect` do?" by paging through the bundled `cli-usage.md` topic in-context. We tested this with PA: user reports the agent "clearly understands the cfcf full context and is very helpful".
2. **Markdown structure makes the bundle navigable.** Every help topic has a `## Topic: <slug> — <title>` separator. The agent uses the headings to find what it needs.
3. **No build pipeline.** Docs are read at launch from the embedded bundle (`packages/core/src/help-content.generated.ts`, generated by `scripts/embed-help-content.ts` from the source `.md` files). cfcf rebuilds the bundle whenever docs change; agent gets fresh content every launch.
4. **Adapter-agnostic.** Both claude-code and codex consume the prompt the same way (Pattern A: ephemeral system-prompt input). Future agent CLIs that follow the same convention drop in trivially.

**Costs accepted.**
- Tokens per turn are higher (the bundle is in the system message that's part of every turn's context). For HA/PA this is fine — they're interactive and short-lived. We do NOT use this pattern for the iteration-time agents (dev/judge/SA/reflection/documenter), whose runs are long + numerous — for those, signal-file-driven IO with smaller per-role prompts is correct.
- System prompt size scales with documentation volume. We monitor size + version it (current ≈170 KB; warns above 250 KB would be a soft cap if added).
- "Hallucination" risk: the agent can still confidently state non-facts. Mitigation: the bundle is the ground truth, and the role prompts say "treat the docs below as authoritative; cite topic + section when explaining cfcf concepts".

**Where this pattern applies (and doesn't).**

| Apply | Skip |
|---|---|
| Interactive roles where the user asks open-ended cfcf questions | Iteration-time agents (dev / judge / SA / reflection / documenter) |
| Roles whose value depends on understanding the SDLC, not just executing fixed steps | Tools that don't need cfcf-meta knowledge (e.g. a future "linter" role) |
| When the user is in the room to course-correct | Non-interactive agents (no human at the keyboard) |

**Lessons.**

1. **Big context windows changed the design space.** Patterns that were impossible in 2023 (dump 160 KB of docs into a system prompt) are trivial in 2026. Re-evaluate "expensive" assumptions periodically — what was infeasible may be the simplest path now.
2. **Adapter-agnostic patterns are achievable when you respect the lowest-common-denominator interface.** Pattern A (system-prompt-as-input) works across both supported agents. Pattern B (auto-load from cwd) was more clever but locked us into per-CLI quirks; we abandoned it for v2.
3. **Dogfood is the validator.** "Will an agent really understand 160 KB of documentation?" was an open question until users said yes. Build the simplest thing, ship to dogfood, listen.

**Outcome.** Pattern is now the canonical approach for any future cfcf interactive role. Documented in `docs/research/help-assistant.md` (HA's design baseline) + `docs/research/product-architect-design.md` (PA's design baseline). Future role authors should reuse the launcher seam in `packages/core/src/<role>/launcher.ts` rather than re-inventing the prompt-injection mechanism.

---

## 2026-04-28 — Bun-dedup workaround: lessons from getting it wrong three times

**Context.** `bun install -g <local-tarball>` (and at least some non-registry URL forms) appends duplicate `"<key>": <value>` entries to `~/.bun/install/global/{package.json,bun.lock}` instead of overwriting. Functionally harmless (last-occurrence wins on parse) but produces dozens of `warn: Duplicate key` lines on every subsequent install — looks like cf² is broken when it isn't. Workaround = dedup these files before/after each `bun install -g` we trigger.

**The path to the right fix.** Three iterations, each fixing a different wrong assumption:

1. **First attempt: `JSON.parse` round-trip.** Naïve approach: parse the file (parser collapses dup keys to last occurrence), re-stringify. Worked on `package.json` but **failed silently** on `bun.lock` because `bun.lock` is JSON5-shaped (trailing commas, JSON Parse error on strict parse). Our try/catch swallowed the error; the dedup was a no-op on the file that mattered most. Lesson: when "best-effort" code fails silently, you don't notice until empirical testing.

2. **Second attempt: dedup identical lines.** Switched to text-based: drop any object-entry line we've seen before. Caught some cases but **missed the same-key/different-value variant** — bun creates dups like `"@x": "/path/foo.tgz"` and `"@x": "file:///path/foo.tgz"` (same key, normalised value forms). Different lines, identical-line dedup misses them. Lesson: the dup pattern isn't "appended same line"; it's "appended same key with a different value form". Harder to detect via text comparison.

3. **Third attempt: keep-last-occurrence by line content.** Tracked each key's last-seen line content; only emitted lines whose content matched their key's last-seen value. Worked for the path-vs-file:// case but **broke when both lines were byte-identical** (same key + same value): both lines matched the "last-seen content" check, both got printed, dedup did nothing. Lesson: when comparing "is this the canonical occurrence?", track an INDEX not the content — content equality is undecidable when content is identical.

**Final fix** (works empirically, both first and second installs are dup-free):

- Walk consecutive object-entry lines into a "run" array.
- For each entry, record `last_idx_for_key[k] = current_run_index`.
- When the run ends (non-entry line: `{`, `}`, blank), emit only entries whose run index matches the recorded last index for their key.
- Naturally scopes dedup to a single object literal (different sections of `bun.lock` have separate runs separated by structural lines, so legitimate same-key-in-different-section entries are preserved).

Implementation in `scripts/install.sh`'s `dedup_bun_global` and the equivalent JS in `packages/cli/src/commands/self-update.ts`. Used both before AND after each `bun install -g` (bun creates the dup mid-install; pre-install dedup catches accumulated mess from earlier runs, post-install catches the freshly-created dup).

**Lessons worth keeping.**

1. **Best-effort code that fails silently is a debugging trap.** `try { ... } catch { /* ignore */ }` masks "I don't know why this isn't working". Add at least one failure-path log line — the user shouldn't have to drop into the source to discover the silent no-op.
2. **Empirical loop > assumptions about file structure.** I assumed `bun.lock` was JSON; it's JSON5. I assumed dups were consecutive; they were interleaved. I assumed "same content" meant "same line"; sometimes content was identical and the same content matched both members of a dup pair. Each assumption looked obvious until the empirical test broke it.
3. **When deduping, track by stable identifier (index, line number) not by content.** Content-based identity comparisons are brittle when content can be identical.
4. **Dump file state between operations.** The `head bun.lock` + `grep -c` pattern surfaced exactly which dup pattern bun was generating. Two minutes of empirical inspection saved an hour of speculation.

**Outcome.** Tagged in v0.15.0 (the current iter-5 PR4 work). Workaround can be removed if/when bun fixes the underlying append-vs-overwrite bug; until then, our dedup runs both sides of every `bun install -g`.

---

## 2026-04-27 — Brand naming: cf² in user-facing surfaces, cfcf in code

**Context.** The project has two interchangeable names: **cfcf** (Cerefox Code Factory) and **cf²** (pronounced "cf square"). Both have always been valid but their usage drifted: the v0.14.0 user manual + Help-tab work mixed both forms in user-facing prose (e.g. "**cfcf** is the harness" alongside "**cf²** doesn't fight users…"). Inconsistent, confusing for new users.

**Decision.** Codify the existing implicit principle:

- **Use `cf²` in user-facing documentation, UI labels, and prose mentions.** This is the brand. It's what users say out loud and read in headings.
- **Use `cfcf` in source code, CLI commands, file paths, package names, environment variables, and any technical identifier.** This is the keystroke-friendly form. It's what users type and what tools recognise.

Specifically:

| Context | Form | Examples |
|---|---|---|
| H1 / H2 in user docs | `cf²` | `# cf² User Manual`, `## What problem cf² solves` |
| Prose ("cf² is", "cf² does") | `cf²` | "cf² only modifies content between sentinels" |
| CLI command literals | `cfcf` | `cfcf help`, `cfcf init`, `cfcf clio search` |
| File paths | `cfcf` | `~/.cfcf/clio.db`, `cfcf-docs/problem.md` |
| Package names | `cfcf` (historical) | `@cfcf/core` (workspace), `@cerefox/codefactory` since 5.5b |
| Sentinel comments | `cfcf` | `# >>> cfcf shell completion >>>` |
| Source-code identifiers | `cfcf` | `cfcf-config-dir`, `CFCF_PORT` |
| Conversation / headlines | `cf²` | "cf² is a deterministic harness" |

**Why both forms.** `cfcf` is keystroke-friendly (4 letters, all lowercase, single hand), which matters every time a user types a command. `cf²` reads as a brand and looks distinctive. Different users encounter different tradeoffs at different times; one form would compromise both.

**Why this convention is sustainable.** The split is mechanical: anything a user **types** stays `cfcf` (otherwise we'd have to teach people to type a Unicode superscript). Anything a user **reads** uses `cf²` (because it's the brand name we want them to associate with the project). No judgement calls; the rule audits itself.

**Outcome.** Swept `docs/guides/manual.md`, `troubleshooting.md`, `installing.md` to apply the rule. Regenerated the embedded help bundle so `cfcf help` (CLI) and the web UI Help tab serve the corrected text. Tagged v0.14.2.

**Lessons.** When a project has two forms of its name, lock the convention before user-facing surfaces ship. The cost of a sweep grows linearly with how much content references both forms — cheap at v0.14.x; would have been a chore at v1.0.

---

## 2026-04-27 — Clio CLI verbs: namespaced surface with a three-clause rule

**Context.** The Clio CLI accreted across three iterations (5.7 → 5.11 → 5.12 → 5.13) without revisiting the overall shape. Iter-5 dogfood produced repeated "where do I do X?" friction (rename a doc, move it between projects, edit metadata) — same root cause: doc operations were scattered between top-level (`get`, `delete`, `restore`, `versions`, `ingest`) and a `docs` namespace (`docs list`, `docs edit`). Plan item 5.8 promoted this to a normalisation pass before writing the user manual.

**Options considered.**

1. **Literal Cerefox CLI parity.** Audit of `../cerefox/src/cerefox/cli.py` showed Cerefox's CLI is internally inconsistent (`list-docs` plural vs `delete-doc` singular; `metadata-search` flips noun-verb ordering vs `list-docs`). Inheriting that mess would import the wrong shape.
2. **Both `search` and `ingest` under `docs`.** Maximally rule-bound. Forces `metadata search` / `metadata keys` into either `docs metadata search` (3-deep nesting) or `docs metadata-search` (hyphen rebirth). Rejected.
3. **Mode flag (`search --content` / `search --metadata`).** Collapses two operations with different ranking semantics (BM25/cosine vs `updated_at desc`) and parameter shapes (string vs JSON filter). Orphans `metadata keys` with no good home. Rejected.
4. **Both `search` + `ingest` top-level (no namespacing for either).** Returns to the pre-cleanup scattered state. Rejected.
5. **`search` top-level + `ingest` under `docs`** (with corresponding `metadata.search/keys`, `projects.list/create/show`, `embedder.list/active/install/set` namespaces). Selected.

**Decision.** Option 5 — namespaced surface with three-clause rule:

> 1. Collection-wide / Clio-wide / headline operations stay top-level (`search`, `audit`, `reindex`, `stats`).
> 2. Verbs that operate on a specific noun-instance go under that noun's namespace (`docs ingest/get/edit/delete/restore/versions`, `projects create/show`, `embedder install/set`).
> 3. A sub-concept with multiple operations of its own gets its own namespace (`metadata search/keys`).

Search and ingest sit on opposite sides of the rule because they play different roles: search produces a *ranking from the whole collection* (clause 1), ingest creates *a specific doc-instance* (clause 2). The asymmetry has a real reason. Option 5 is also the only shape where `metadata` reads as a clean sibling namespace next to `docs`/`projects`/`embedder` — the killed alternatives all force `metadata` into awkward nesting or hyphen-rebirth.

**No deprecation aliases.** Single user, pre-OSS-launch. Rename cleanly, no legacy verbs.

**Out of scope** (this round): top-level cfcf verbs (`workspace`, `run`, `review`, `reflect`, `document`, `server`, `config`, `init`, `doctor`, `self-update`, `status`, `resume`, `stop`). Iter 6 will audit those with the same lens.

**Why this matters for parity.** Cerefox parity is at the *abstraction layer* — every Cerefox MCP tool maps to a `MemoryBackend` method, and every cfcf CLI verb maps to a `MemoryBackend` method. The CLI surface itself can be cleaner than Cerefox's CLI without breaking that mapping. The user noted that cfcf's clean shape can serve as a reference for a future Cerefox CLI cleanup at the Cerefox-OSS level.

**Reference.** Full audit, killed-alternatives analysis, and locked surface in [`docs/research/cli-verb-normalisation.md`](research/cli-verb-normalisation.md).

---

## 2026-04-27 — Embedder-recommended chunk size as a safety ceiling, plus pre-flight warnings on switch + reindex

**Context.** Each embedder in the catalogue declares a `recommendedChunkMaxChars` calibrated for its tokenizer's `model_max_length` minus a safety margin (e.g. 1800 chars ≈ 4 chars/token × 0.9 × 512 tokens for a `bge-small-en-v1.5`-class context). Two related risks emerged once `clio.maxChunkChars` became user-configurable:

1. User sets `clio.maxChunkChars` larger than the active embedder's `recommendedChunkMaxChars`. Inputs above that ceiling get silently truncated by transformers.js / ORT to `model_max_length`, degrading embedding quality with no error path.
2. User runs `cfcf clio embedder set <new>` to switch to a model with a smaller ceiling. Existing chunks now exceed the new model's context window AND existing embeddings live in the old model's vector space.

**Decisions.**

1. **Treat `recommendedChunkMaxChars` as a ceiling, not a fixed override.** Smaller user values are honoured (smaller-is-safe; sometimes better for retrieval precision). Larger user values get capped at the embedder's ceiling with one stderr warning per ingest call. Without an active embedder there's no ceiling.
2. **Pre-flight warnings on `cfcf clio embedder set`.** New `GET /api/clio/embedders/:name/switch-impact` returns three counts: `embeddedChunkCount` (existing-embedding mismatch), `chunksOverNewCeiling` (truncation risk), `configMaxOverCeiling` (config setting will be capped). The CLI prompts y/N when any signal fires, requires `--yes` for non-interactive use. The existing `--force` (recovery, no checks) and `--reindex` (switch + re-embed atomically) remain.
3. **Pre-flight confirmation on `cfcf clio reindex`.** Reindex re-embeds many chunks under the active embedder; non-trivial cost. CLI prints active embedder + scope + cost hint, prompts y/N. `--yes` skips for non-interactive use; `--force` already skipped by historical contract.
4. **Web UI Server Info page surfaces all of these.** The new chunk-size input shows the cap warning inline when its value exceeds the active embedder's ceiling. The preferred-embedder line includes guidance on switching safely (`--reindex` recommended, `--force` for recovery only).

**Why warning-and-prompt instead of auto-correct.** Same principle as on-demand version retention (item 6.22): silent rewrites of corpus state surprise users in unattended-agent workflows. The user sees the impact and explicitly opts in.

**Out of scope (tracked).** The `--rechunk` capability (re-run the chunker per doc when switching to a model with a smaller ceiling) is plan item 6.23. Until then, the warning text recommends `cfcf clio reindex --rechunk` (planned).

---

## 2026-04-27 — Hybrid search algorithm: alpha-weighted score blending over RRF

**Context.** The Clio hybrid-search engine fuses an FTS (keyword) candidate set with a vector (semantic) candidate set into a single ranked list. The original implementation used Reciprocal Rank Fusion (RRF) with `k=60`; a side-by-side audit against Cerefox surfaced that Cerefox uses **alpha-weighted score blending** (`α × cosine + (1−α) × ts_rank_cd`, default `α=0.7`) and exposes `α` as a tunable per-call. cfcf had no equivalent knob.

**Options considered.**
1. Keep RRF, add a weight knob: `α/(k+vec_rank) + (1−α)/(k+fts_rank)` — same user-visible α, different math.
2. Switch to Cerefox-style score blending — same user-visible α and same underlying math.

**Decision.** Option 2: score blending. Tunable per-call (`alpha` query param / `--alpha` CLI flag) with `clio.hybridAlpha` global default of `0.7`. FTS-bypass-on-threshold semantics preserved (FTS-matched chunks always pass the `minScore` floor regardless of cosine).

**Implementation note — BM25 renormalisation.** SQLite FTS5's `bm25()` returns values in `[-∞, 0]` where more-negative = more relevant; not directly comparable to cosine `[0, 1]`. The fix is min-max normalisation within the candidate pool: `(maxRank − bm25) / (maxRank − minRank)` produces a `[0, 1]` higher-better score. Trade-off: absolute blended scores depend on candidate-pool composition (different filter combos can produce different absolute scores) but **relative ranking is preserved** — which is what hybrid cares about. Cerefox doesn't need this step because Postgres' `ts_rank_cd` is already roughly `[0, 1]`.

**Lesson.** Choose hybrid-fusion algorithm to match what the upstream system exposes — even when an alternative (RRF) is mathematically defensible, missing the user-visible knob is a real interop gap.

---

## 2026-04-27 — Search defaults to document-level, not chunk-level

**Context.** `cfcf clio search <query>` was returning chunk-level results (one row per matching chunk). Same document with multiple matching chunks produced multiple visually-redundant rows; an unrelated document that mentioned the keyword in passing wedged itself between chunks of the right document. Bad UX for the "what docs match X?" question agents and humans actually ask.

**Options considered.**
1. Keep chunk-level as default; add `--by-doc` flag for dedup.
2. Make doc-level the default; keep chunk-level as `--by-chunk` for raw inspection.

**Decision.** Option 2. Cerefox precedent: their primary `cerefox_search` MCP tool returns one row per matching document; the chunk-level engine `cerefox_hybrid_search` is internal-only.

**Implementation.** New `LocalClio.searchDocuments` fetches `matchCount × 5` chunk candidates via the existing engine, dedups by `document_id` keeping best score, decorates each hit with `versionCount` + `matchingChunks` + the best chunk's content. HTTP `GET /api/clio/search?by=doc` (default) / `?by=chunk` (raw).

**Why surface `versionCount` + `matchingChunks` on hits.** `versionCount` mirrors Cerefox's `cerefox_search_docs.version_count` — agents reasoning about doc maturity ("evolved" vs "fresh") avoid a follow-up `cfcf clio docs versions` call. `matchingChunks` is cfcf-specific — "matched 5 chunks" vs "matched 1 chunk" is a useful breadth signal, near-free given dedup already pools the candidates.

---

## 2026-04-27 — Small-to-big retrieval is per-document, not per-chunk

**Context.** The original Clio implementation expanded each search hit's content with a fixed-radius window of neighbour chunks (radius=1 if embedding dim>768, else 2). Cerefox's `cerefox_search_docs` makes a different per-document decision: documents whose `total_chars` is at most `p_small_to_big_threshold` (default 20000) return the **full document content** as the hit; larger documents return matched chunk + `p_context_window` (default 1) neighbours. Returns `is_partial: bool` so the caller knows which path was taken.

**Decision.** Adopt Cerefox's per-doc logic in the doc-level search path (`searchDocuments`). Configurable via `clio.smallDocThreshold` (default 20000) + `clio.contextWindow` (default 1) globally; per-call overrides via `?small_doc_threshold=` / `--small-doc-threshold` and `?context_window=` / `--context-window`. New result field `DocumentSearchHit.isPartial`.

**Outcome.** Small documents (typed-up notes, design briefs, cheat-sheets) come back in one piece — agents read them inline from the search hit instead of round-tripping to `cfcf clio docs get`. Large documents still return a focused window. Bypasses the chunk-level engine's expansion entirely (`contextWindow=0` actually means "bare chunk", not "chunk + hardcoded radius").

**Lesson.** Retrieval features land at the layer the caller experiences. Per-chunk tricks are right for the chunk-level engine but wrong for the doc-level surface; mirror the right layer's behaviour.

---

## 2026-04-27 — Migration runner: explicit `@migration-flags: disable-foreign-keys` marker

**Context.** SQLite migrations that drop+rebuild a parent table (the canonical "alter constraint" pattern: `CREATE new → INSERT FROM old → DROP old → RENAME new`) trigger `ON DELETE CASCADE` referential actions on child tables for every row in the parent — silently destroying child data. `PRAGMA defer_foreign_keys = ON` postpones FK constraint *checks* but does NOT defer referential *actions*; CASCADE fires immediately. The only working solution is `PRAGMA foreign_keys = OFF` set **outside** the wrapping transaction (the pragma is a no-op inside an active transaction).

**Decision.** The migration runner scans each migration's first 4 lines for a `-- @migration-flags: disable-foreign-keys` marker. When present, it brackets the migration's `BEGIN IMMEDIATE / COMMIT` with `PRAGMA foreign_keys = OFF / ON` outside the transaction. Migrations that drop+rebuild a parent with CASCADE children must declare the flag.

**Lesson.** Read the SQLite docs for pragma semantics carefully: `defer_foreign_keys` and `foreign_keys = OFF` solve different problems and are not interchangeable. Migration tests must run against a populated database, not a fresh one — `defer_foreign_keys` happens to "work" on an empty schema (no cascade target → no observable bug) but fails on real data.

---

## 2026-04-27 — Cerefox-parity gap: version retention deferred (on-demand cleanup over lazy)

**Context.** Cerefox runs lazy version retention on every snapshot: deletes versions older than `CEREFOX_VERSION_RETENTION_HOURS` (default 48), always keeps the most-recent version, skips `archived=true` versions. cfcf's `clio_document_versions` accumulate forever; the schema has the `archived` column but nothing reads it.

**Options considered.**
1. Match Cerefox: lazy auto-cleanup on every snapshot.
2. Explicit on-demand: `cfcf clio cleanup-versions [--older-than 168h] [--keep-last 1] [--dry-run]`.
3. Both: opt-in lazy via config + always-available on-demand.

**Decision.** Option 3, with on-demand as the default. Silent automatic deletion of historical content surprises users in an agent-driven workflow; the trust story for unattended runs is "nothing disappears unless I ask". Auto-cleanup is gated on `clio.versionRetentionHours` config so users who do want Cerefox's behaviour can opt in.

**Status.** Tracked as plan item 6.22; not implemented in iter-5. Default thresholds will match Cerefox's. Respects `archived=true`.

---

## 2026-04-26 — Clio data-model conventions

**Context.** Several small, related Clio schema choices baked into the implementation. Consolidated here so they're discoverable.

**Decisions.**

1. **`version_id IS NULL` = live; FTS triggers gate on it.** The `clio_chunks_fts_au` trigger fires on UPDATE with predicate `WHEN old.version_id IS NULL OR new.version_id IS NULL` — so the snapshot path's `UPDATE clio_chunks SET version_id = <new>` automatically removes prior chunks from the FTS index, and the subsequent INSERT of new chunks adds them back. Schema-level invariant; zero application code needed to keep search and versions in sync.

2. **`author` is a typed first-class column on `clio_documents`.** Cerefox keeps author only on the audit log. cfcf promotes it to a column because (a) search hits and listings render it inline without a JOIN, (b) future audit/retention queries filter heavily on author, (c) the storage cost is negligible vs. the query simplicity. Default `'agent'` so legacy records backfill cleanly.

3. **Version row's `source` carries the OUTGOING author, not the trigger label.** Cerefox's `cerefox_document_versions.source` stores the snapshot trigger (`"file"` / `"agent"` / etc.). cfcf's same column instead stores `target.author` at update time — i.e. who wrote the content being archived. Different read-model: `cfcf clio docs versions <id>` answers "who wrote v3?" with `versions[0].source` directly, no audit-log JOIN needed.

4. **Audit log is write-only.** The `clio_audit_log` schema (from initial schema) reserves `event_type` values for `'search'` and `'get'` but the live writer skips them. Reasons: (a) volume — every preload-context read in the iteration loop would write a row, dwarfing actual mutation entries; (b) the trust story is "who changed what", not "who saw what"; (c) Cerefox's `cerefox_audit_log` is also write-only in practice. The columns stay (no migration churn) so a future "verbose mode" could turn read-logging back on without schema work.

5. **Audit writes are best-effort, outside the mutation transaction.** A failure in `writeAudit` warns to stderr and returns; the mutation still succeeds. Wrapping audit + mutation in one transaction would mean a stuck audit could roll back successful ingests — wrong failure mode for an observability layer. Symmetric to Cerefox's `cerefox_create_audit_entry` (`PERFORM`-ed at the bottom of ingest RPCs, return value not checked). Idempotent no-op delete/restore (already-deleted / already-live) intentionally do NOT write audit rows.

6. **`IngestResult.action` enum is the source of truth; legacy `created` boolean kept one release.** With three outcomes (`"created"`, `"updated"`, `"skipped"`) a boolean stops carrying signal. `created` is preserved (`true` iff `action === "created"`) so existing callers keep working; the field is `@deprecated` and will be removed once dependent code (notably `iteration-loop`'s auto-ingest hooks) migrates. Same pattern as Cerefox's `IngestResult.action`.

7. **`--document-id` updates preserve title/author when not explicitly passed.** Cerefox always rewrites title/author from RPC parameters because their MCP layer requires them. cfcf's CLI ingests files where `title` defaults to the file basename — silently overwriting an existing doc's deliberately-named title was a footgun. Updates by ID now preserve the existing values when the caller omits them; explicit `--title` / `--author` still override. Documented divergence from Cerefox at the API layer.

---

## 2026-04-26 — Installer architecture: npm-format CLI, not self-contained binary

**Context.** Initial plan: ship cfcf as a `bun --compile` self-contained native binary in a tarball with colocated `node_modules/` for externalised heavy native deps (`@huggingface/transformers`, `onnxruntime-node`, `sharp`) plus pinned native libraries (custom-built libsqlite3 with `loadExtension` enabled, sqlite-vec). Curl-bash installs to `~/.cfcf/bin/`. Phase-0 smoke passed. Then the first real `cfcf init` against the binary failed with `Cannot find module '@huggingface/transformers' from '/$bunfs/root/cfcf'`.

**The wall: Bun `--compile` doesn't resolve heavy native deps from disk.**

`bun build --compile --external <pkg>` is supposed to produce a binary where `<pkg>` resolves at runtime via standard Node module resolution. In practice, Bun's compile-mode runtime resolver searches only the embedded `/$bunfs/root/` filesystem; it does not walk to disk for `--external` modules. Verified: `cfcf-binary` with deps colocated at `~/.cfcf/bin/node_modules/@huggingface/transformers/` — direct invocation errors `Cannot find module '@huggingface/transformers' from '/$bunfs/root/cfcf'`. Same with `NODE_PATH=...` set explicitly (Bun ignores it in compile mode).

**Workarounds attempted, none of which worked:**
1. Static absolute path in `import()` — Bun treats it as a bare specifier.
2. `file://` URL in `import()` — top-level loads, transitive imports re-enter the same broken resolver.
3. Static top-level `import * as Transformers from "@huggingface/transformers"` to force compiler analysis — Bun's compile-mode bundler quietly externalises packages with native `.node` addons or dynamic `require()` patterns regardless of the `--external` flag. Binary stays the same size; no transformers-related strings embedded.
4. `createRequire(process.execPath)` — transformers is ESM, `createRequire` is CJS-only.
5. Wrapper shell script that sets up env before exec — symptoms suggested env tweaks wouldn't help (the issue is internal to Bun's resolver path-walking).

**Why this isn't fixable in our codebase.** Bun's `--compile` is designed for the case "JS that I can fully bundle." Heavy native-addon deps with dynamic `require()` patterns (which `onnxruntime-node` does to load its `.node` binary based on `process.platform`/`arch`) sit outside that model. Hugging Face's own docs explicitly recommend `serverComponentsExternalPackages: ['onnxruntime-node']` for Next.js — their idiomatic stance is "don't bundle this, expect the runtime to resolve it." Tools that DO ship self-contained AI inference (Ollama, LM Studio) are written in Go/Rust with C++ inference engines linked directly; they don't use transformers.js. **No widely-used tool ships transformers.js inside a `bun --compile` / `pkg` / `nexe`-style binary.**

**Decision: pivot to npm-format distribution.**
- Build: `bun build` (without `--compile`) bundles the TypeScript source into a single `dist/cfcf.js`. `bun pm pack` wraps it + `package.json` into an npm-format `cfcf-X.Y.Z.tgz`.
- Distribution: GitHub Releases tarball asset (private repo) → `bun publish` to npmjs.com when the project goes public.
- User install: `bun install -g <tarball-URL>` (or `npm install -g <tarball-URL>`). A small `install.sh` wrapper provides curl-bash UX and bootstraps Bun if missing.
- Runtime: Bun ≥ 1.3 is a hard requirement (declared in `package.json`'s `engines.bun` and in the README).
- Native deps: per-platform optional npm packages (`@cerefox/cfcf-native-darwin-arm64`, etc.) declared in the CLI's `optionalDependencies`. npm picks the right one based on `os` + `cpu` fields. `applyCustomSqlite()` resolves the package path via `require.resolve`. Same pattern Claude Code, sharp, swc, and esbuild use.

**Lessons.**
- **Validate the gnarliest path first.** Smoke tests proved `cfcf --version` and `cfcf clio embedder list` worked from a compiled binary, but neither imports transformers. The actual transformers-loading path was not exercised until end-to-end install. **A real smoke must invoke at least one command that hits every external dep.**
- **Be skeptical of "just works at runtime" docs.** Bun's `--compile` docs state externals resolve at runtime "as normal." That's not what happens for our shape. Where docs are vague, run a focused test before committing to a design.
- **Match the upstream stack's distribution model.** transformers.js's docs, examples, and supported deployment targets all assume Node-ecosystem distribution. Trying to shoehorn it into a self-contained binary fights the entire ecosystem's design.
- **Self-contained binaries fit a specific shape.** Bun `--compile` / `pkg` / `nexe` / Deno `--compile` work great when deps are JS-only or have native deps that statically analyse. Heavy-native-addon deps with dynamic loading break this model. **Default to npm-format unless there's a strong reason for self-contained.**
- **Time-box workaround attempts.** When a design hits an unexpected wall, time-box the workarounds (one hour, two attempts) before stepping back to question the design itself.
- **Diagnostic signature.** `Cannot find module 'X' from '/$bunfs/root/...'` is a Bun-compile-mode-specific signature. If a future investigation surfaces it, jump straight to "is this resolver actually walking to disk?" rather than chasing path config.

---

## 2026-04-26 — `process.execPath` is the runtime, not the script, in npm-format installs

**Context.** A "re-spawn self with env var" pattern (used to host the cfcf server in the same binary as the CLI: `Bun.spawn([process.execPath], { env: { CFCF_INTERNAL_SERVE: "1" } })`) worked under the old `bun --compile` binary because `process.execPath` *was* the cfcf entry. Under the new npm-format install, `process.execPath` is the **bun runtime**; re-spawning bare bun with no script argument launches a Bun REPL. The server never starts.

**Decision.** Derive the bundled JS path from `import.meta.url` and spawn `bun run <bundle>` with the env var set. The bundled JS is the entry; bun runs it.

**Lesson.** Any "re-spawn self" pattern needs to know whether `process.execPath` is the entry or the runtime. They're the same thing for a `--compile` binary and different for everything else. Generalising: be explicit about which artifact you're invoking when re-spawning.

---

## 2026-04-25 — Hybrid search vector threshold (Cerefox parity + the wrapper-layer-invariants lesson)

**Context.** A single-document Clio corpus + an irrelevant query was returning that one document as a "match" — vector candidates with near-zero cosine were being fused into the result set rather than dropped. The fusion algorithm was correct; the missing piece was a noise-floor filter.

**Cerefox precedent.** Cerefox uses `CEREFOX_MIN_SEARCH_SCORE = 0.50` as a cosine-similarity floor on the vector branch:
- In hybrid search: chunks that matched the FTS keyword operator pass through regardless. The threshold filters only vector-only candidates.
- In semantic search: every result is filtered by cosine ≥ threshold.
- In FTS search: threshold ignored entirely.

The 0.50 default was calibrated for OpenAI `text-embedding-3-small`. Cerefox's published guidance:

| Score | Meaning (text-embedding-3-small) |
|-------|---|
| 0.0 – 0.20 | Noise floor — unrelated content |
| 0.20 – 0.45 | Weak / tangential — same domain, different topic |
| 0.45 – 0.70 | Genuine match — related concepts, paraphrases |
| 0.70 – 1.0  | Near-duplicate / direct answer |

**Decision.** Mirror the architecture exactly. Threshold sourced via cfcf's standard precedence chain: per-call (`--min-score` / `?min_score=`) → per-config (`clio.minSearchScore`) → built-in default 0.5. `searchSemantic` filters all candidates by raw cosine; `searchHybrid` filters only the vector-only branch (FTS-matched chunks always pass).

**Calibration caveat.** Cerefox's 0.50 was tuned for `text-embedding-3-small`. cfcf ships with `bge-small-en-v1.5` (Xenova, 384d) and the default `nomic-embed-text-v1.5` (q8, 768d). Different models produce different cosine distributions. The 0.5 default may need recalibration with empirical data from a non-trivial corpus. The user-tunable knob means recalibration doesn't have to ship in code — users dial `clio.minSearchScore` per their corpus. A future Clio v2 item should add per-embedder default thresholds to the catalogue.

**Lesson — port the wrapper-layer invariants too, not just the engine.** When porting from a system that's been used in anger, tightening rules added later (filters, retries, rate limits, validation guards) are usually load-bearing in ways that don't show up in algorithm diagrams. cfcf's PR2 ported Cerefox's SQL/RPC layer 1:1 — BM25, vector cosine, RRF fusion, small-to-big — but missed this threshold because it lives in Cerefox's Python `Searcher` wrapper, not in the RPC. **A literal port of the engine misses wrapper-layer invariants.**

---

## 2026-04-25 — Cerefox ↔ cfcf-Clio parity at the `MemoryBackend` boundary

**Context.** Cerefox is the OSS shared-agent-memory system; cfcf-Clio is the local-only embedded variant. The current architecture has `LocalClio` as the default `MemoryBackend` implementation; a future `CerefoxRemote` adapter should swap in for cross-machine sharing without caller-side changes.

**Decision (architectural commitment).** Maintain parity at the `MemoryBackend` boundary:
- **Search semantics** must match (mode names, threshold semantics, FTS-bypass rule, small-to-big behaviour, hybrid blending). New retrieval features land in both surfaces with the same shape — or are explicitly scoped as local-only with documented rationale.
- **Schema field names** must map 1:1 where possible (e.g. `clio_documents` ↔ `cerefox_documents`; `metadata` is JSONB on Cerefox / TEXT-JSON on Clio with the same well-known keys: `workspace_id`, `role`, `artifact_type`, `tier`).
- **Defaults must align unless intentionally different.** When deviations exist (e.g. cfcf's per-embedder `recommendedChunkMaxChars` overrides a flat global default), the deviation is a documented design choice, not drift.
- **Future Cerefox changes are evaluated for cfcf inclusion.** Currently mirrored or planned: audit log, soft-delete + versioning, metadata-key discovery, retention config.

**Trade-off.** Every Cerefox change becomes a "should we mirror this?" decision. The cost of letting them drift is high: every divergence becomes a behaviour surprise when a future user swaps in `CerefoxRemote`. **Document deviations explicitly in this log when they happen.**

---

## 2026-04-25 — Embedder version pin: `transformers@3.8.1` + `onnxruntime-node@1.21.0` for Intel Mac support

**Context.** `onnxruntime-node` 1.24.x dropped `darwin-x64` (Intel Mac) binaries. `@huggingface/transformers` 4.x pins ORT-node 1.24.x — meaning shipping transformers 4.x means dropping Intel Mac users.

**Options considered.**
1. Drop Intel Mac. Use the latest transformers + ORT-node.
2. Pin transformers + ORT-node to the last pair with darwin-x64 binaries.
3. WASM-via-`onnxruntime-web` (browser ORT-web) on Node. Avoids platform-specific native binaries entirely.

**Decision.** Option 2: pin `@huggingface/transformers@3.8.1` + `onnxruntime-node@1.21.0`. cfcf only uses the long-stable `pipeline("feature-extraction", ...)` API, so being a few minor versions behind has no functional impact today.

**Why not Option 3 (WASM).** Probed and deferred. `transformers.js` bundles the **browser** ORT-web build, which loads models via `fetch(URL)`; when Node passes it a local file path, it errors `ERR_INVALID_URL`. There's no built-in WASM-on-Node code path. Making it work requires either vendoring/forking transformers.js or rolling our own embedder using `onnxruntime-web/node` + a separate tokeniser (~1–2 weeks). Revisit if Microsoft permanently stays off `darwin-x64` AND staying behind on transformers becomes a real cost.

**Exit criteria for revisiting the pin.** The pin is a load-bearing-but-soft commitment, not permanent. Reconsider when *any* of these becomes true:
- A cfcf feature requires a transformers.js 4.x-only API.
- A security advisory lands against ORT-node 1.21.0 or transformers.js 3.8.1 with no patch backport.
- The Intel-Mac user population shrinks below the threshold where continued darwin-x64 testing pays for itself.
- Microsoft restores Intel-Mac binaries in a future ORT-node release (in which case we just bump versions).

If we drop Intel Mac later, the path is: bump transformers + ORT-node to current; drop `darwin-x64` from the installer's release matrix; document the change here. The graceful FTS-only fallback in `LocalClio.getEmbedder()` means existing Intel-Mac users wouldn't be hard-broken — they'd lose semantic search, with a clear on-screen explanation and the option to switch to the linux-x64 tarball under WSL / Docker / Lima.

---

## 2026-04-22 — Default embedder: `nomic-embed-text-v1.5` q8 over bge-small

**Context.** The Clio implementation initially defaulted to `bge-small-en-v1.5` (~120 MB, 384d, ~512 token context). Long design documents and iteration logs ended up split into many small chunks because the embedder's context window forced the chunker to slice aggressively.

**Decision.** Default to `nomic-embed-text-v1.5` (q8 quantised, ~130 MB, 768d, ~8k token context). Comfortably fits the chunker's 4k-token effective window so long docs embed as one coherent passage. `DEFAULT_EMBEDDER_NAME` in the catalogue is the single source of truth — `cfcf init`'s `★` marker, the no-arg `cfcf clio embedder install` fallback, the FTS-only "next steps" hint all read from it.

**Lessons (when adding a new embedder to the catalogue).**
- **Check upstream for ONNX dtype variants.** `nomic-ai/nomic-embed-text-v1.5` publishes both `model.onnx` (522 MB fp32) and `model_quantized.onnx` (~130 MB q8). Without an explicit hint, `transformers.pipeline()` picks fp32, ballooning the install. The catalogue's `dtype` field forces the right variant.
- **Mirrors can go restricted.** The `Xenova/nomic-embed-text-v1.5` mirror went 401-gated at some point; the official `nomic-ai/nomic-embed-text-v1.5` repo has the same ONNX layout and `transformers.js` loads it identically. Workaround when a future Xenova mirror also goes 401: find the upstream `<org>/<model>` repo on HF and verify it has the `onnx/` subdirectory + `config.json` + `tokenizer*.json`.

---

## 2026-04-12 — Async iteration: server runs in background, CLI polls

**Context.** First real agent run failed because `Bun.serve` has a max idleTimeout of 255 seconds and the CLI's `fetch()` has a 10-second default. Agent runs can take minutes or hours. The synchronous request/response model (CLI sends POST, server runs agent, returns result when done) fundamentally doesn't work for long-running operations.

**Decision.** Refactor to async. `POST /api/projects/:id/iterate` returns 202 immediately; the server runs the agent in the background via `iteration-runner.ts`. The CLI polls `GET /api/projects/:id/iterations/:n/status` every 2 seconds, showing real-time progress dots. SSE log streaming via `/iterations/:n/logs`. No timeout issues regardless of how long the agent runs.

---

## 2026-04-12 — Loop state persisted to disk on every phase transition

**Context.** In-memory loop state is lost on server restart. This includes `bun --watch` restarts (file changes during development), crashes, and manual restarts. Without persistence, `cfcf resume` fails after any restart with "No active loop for this workspace".

**Decision.** Persist `LoopState` to `<workspace-config-dir>/loop-state.json` on every phase transition. Load from disk as fallback in `getLoopState()`. The on-disk file is the source of truth; in-memory state is a cache.

---

## 2026-04-12 — Judge failure: capture exit code, log path, and retry-only-judge

**Context.** When a judge agent fails (wrong CLI flags, crash, etc.), the loop correctly pauses with `anomaly`, but the original implementation gave no clue about the cause — `anomaly` displayed alone with no log path, no exit code, no hint.

**Decision.** Capture `judgeError` with exit code and log path; show in CLI pause output. Set a `retryJudge` flag so `cfcf resume` retries only the judge on the same branch rather than starting a full new iteration (and discarding completed dev work).

**Principle.** For unattended runs, every failure path needs a self-explaining hint. Bare states like `anomaly` without context shift the diagnostic burden onto the user.

---

## 2026-04-12 — Iteration branch recovery: delete + recreate from HEAD

**Context.** When an iteration fails and the user retries, the iteration branch may already exist from the failed attempt but point to a different base (e.g., off `main` instead of the current feature branch). Naive `checkout` of the stale branch loses the working directory contents.

**Decision.** Delete the existing branch and recreate it off current HEAD. Validate the problem-pack BEFORE switching branches so failures surface before any branch manipulation.

---

## 2026-04-12 — Codex CLI: global flags must precede the subcommand

**Context.** The Codex adapter's first real judge run failed silently with exit code 2.

**Decision (adapter contract).** Codex CLI requires global flags (like `-a never`) BEFORE the subcommand (`exec`): `codex -a never exec -s danger-full-access "prompt"`. NOT `codex exec -s danger-full-access -a never "prompt"`. Recent Codex versions also removed `--approval-mode full-auto`; cfcf uses `-s danger-full-access` (equivalent to Claude Code's `--dangerously-skip-permissions`).

**Lesson.** Adapter integration tests must run the actual external CLI with the actual flag combinations. Reading docs is not enough — flag-ordering is the kind of thing only failing exit codes reveal.

---

## 2026-04-11 — Server stop via PID file, not shell job control

**Context.** `cfcf server start` spawns a background bun process. Shell job control (`kill %1`) is unreliable across shell contexts (different terminal, restart, etc.).

**Options considered.**
1. Store the PID in a file at startup; read at stop.
2. Scan for the process on the configured port via `lsof -ti :<port>`.

**Decision.** Option 1 (PID file). More robust; doesn't depend on platform-specific port-scanning tools.

---

## 2026-04-11 — `bun test --recursive` hangs with subprocess-spawning tests

**Context.** Process-manager tests that spawn + kill subprocesses (e.g., `sleep 30` with `kill()`) cause `bun test --recursive` to hang.

**Decision.** Run packages sequentially in CI and the root `package.json` test script: `bun test packages/core && bun test packages/server && bun test packages/cli`. Reliable. Confirmed Bun-version-specific issue with `--recursive` and concurrent subprocess management in tests.
