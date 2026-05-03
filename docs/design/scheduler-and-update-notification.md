# JobScheduler + new-version notification

**Status:** Shipped 2026-05-02 in v0.18.0 (item 6.20).

This document captures the design behind the minimal `JobScheduler` primitive and the new-version notification system that uses it. Read this when extending the scheduler (item 6.13 — cron-like recurring execution), changing the update-check policy, or auditing what runs in the background of a cfcf server.

## Goals

1. Notify users about new cfcf releases without ever auto-updating. The user always runs `cfcf self-update` explicitly.
2. Build the smallest restart-resilient periodic-job primitive that satisfies (1) and that 6.13 can extend, instead of duplicating timer mechanics.
3. Keep zero per-CLI-invocation cost on the hot path. The CLI banner is gated to lifecycle commands only.

## Non-goals

Explicit out of scope; deferred to 6.13:

- Cron-expression parsing (`0 8 * * MON`).
- User-defined jobs (CLI `cfcf schedule add`).
- Schedule-management web UI.
- Mutex / concurrency between running jobs (6.20 has one job that does a tiny HTTP fetch).

Permanently out of scope:

- Auto-update of the cfcf binary. The flag file is informational only.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  cfcf server process (long-lived)                                     │
│                                                                       │
│  ┌─────────────────────────┐   ticks every 60s   ┌─────────────────┐ │
│  │ JobScheduler            │ ──────────────────▶ │ update-check    │ │
│  │   register(job)         │                     │ (24h interval)  │ │
│  │   start() / stop()      │                     │   fetch npm     │ │
│  │   tick() (testable)     │                     │   compare semver│ │
│  │                         │                     │   write flag    │ │
│  │  state persisted to     │                     └─────────────────┘ │
│  │  ~/.cfcf/scheduler-     │                              │          │
│  │  state.json after every │                              ▼          │
│  │  job run                │                ~/.cfcf/update-           │
│  │                         │                available.json (or       │
│  │                         │                deleted when caught up)  │
│  └─────────────────────────┘                              │          │
└───────────────────────────────────────────────────────────┼──────────┘
                                                            │
                          ┌─────────────────────────────────┼────────────────────────┐
                          │                                 │                         │
                          ▼                                 ▼                         ▼
              ┌───────────────────────┐       ┌──────────────────────┐    ┌──────────────────────┐
              │ GET /api/update-      │       │ CLI lifecycle banner │    │ cfcf doctor's        │
              │ status                │       │ (init / server /     │    │ checkUpdateAvailable │
              │   200 + JSON, or 204  │       │ status / doctor /    │    │   (one-line warn)    │
              │                       │       │ self-update --check) │    │                      │
              └───────────┬───────────┘       └──────────────────────┘    └──────────────────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │ <UpdateBanner />      │
              │   web UI top bar      │
              │   per-session         │
              │   dismissal           │
              └───────────────────────┘
```

## JobScheduler primitive

**Module:** `packages/core/src/scheduler/`.

### Interface

```ts
interface Job {
  id: string;            // unique per scheduler; persistence key
  intervalMs: number;    // minimum interval between successful runs
  fn: () => Promise<void>;
  lastRun?: Date;
  lastError?: string;
}

class JobScheduler {
  constructor(opts?: {
    tickIntervalMs?: number;       // default 60_000
    statePath?: string;            // default ~/.cfcf/scheduler-state.json
    runOnStartIfDue?: boolean;     // default true
  });
  register(job: Job): void;
  start(): Promise<void>;
  stop(): void;
  tick(): Promise<void>;            // exported for tests
  getJob(id: string): Job | undefined;
}
```

### State file

`~/.cfcf/scheduler-state.json`:

```json
{
  "version": 1,
  "jobs": {
    "update-check": {
      "lastRun": "2026-05-02T12:00:00.000Z",
      "lastError": null
    }
  }
}
```

Written after every job run (not every tick). Cost is small and bounds the restart-loss window per job to a single interval rather than the whole interval.

### Behaviour

- `start()`:
  1. Load state from `statePath` (silently treats missing or corrupt files as no state).
  2. If `runOnStartIfDue` (default true), fire one tick immediately. This is what catches missed ticks across server restarts.
  3. Schedule `setInterval(this.tick, tickIntervalMs)`. Timer is `unref()`'d so it never blocks process exit.
- `tick()`: walk every registered job; if `Date.now() - lastRun >= intervalMs`, run it.
- A job that throws records `lastError` on the Job, but `lastRun` still bumps to `now()` so a perpetually failing job doesn't hot-loop.

### Why one tick over per-job timers

Per-job timers double the surface for very little gain at our scale. One tick keeps the seam tiny (~150 lines incl. tests of state I/O), covers everything 6.20 needs, and makes 6.13's extensions (cron expressions, user-defined jobs) feel like adding to the existing model rather than fighting it. Revisit if a job needs sub-minute granularity.

## update-check job

**Module:** `packages/core/src/update-check.ts`.

```ts
function makeUpdateCheckJob(opts: {
  currentVersion: string;
  intervalMs?: number;                   // default 24h
  filePath?: string;                     // default ~/.cfcf/update-available.json
  fetchLatest?: () => Promise<string>;   // injection seam for tests
  releaseNotesUrl?: ((latest: string) => string) | null;
}): Job;
```

### Behaviour

1. Fetch `https://registry.npmjs.org/@cerefox/codefactory/latest` (5s timeout via `AbortController`).
2. Compare with `compareSemver(latest, currentVersion)`. The comparator strips leading `v` and treats anything after `-` as the same patch number (`0.17.1-dev` == `0.17.1`).
3. If `latest > current`: write `~/.cfcf/update-available.json`. If equal or older: delete the file. The delete branch is what makes the banner self-clear after `cfcf self-update` and protects against stale state from a tag-only release like 0.17.1.

### Flag file shape

`~/.cfcf/update-available.json`:

```json
{
  "currentVersion": "0.17.1",
  "latestVersion": "0.18.0",
  "checkedAt": "2026-05-02T12:00:00.000Z",
  "releaseNotesUrl": "https://github.com/fstamatelopoulos/cfcf/releases/tag/v0.18.0"
}
```

### Stale-flag GC at server startup

The 24h scheduler tick is the canonical "is anything newer?" check, but it doesn't help users who upgrade *within* 24h of the previous tick — the flag file would linger on disk until the next tick (defensive `latestVersion <= VERSION` checks at every read site mean users never see a stale banner, but the file itself is untidy).

`clearStaleUpdateFlag(currentVersion)` runs at the top of `startServer()`, before the JobScheduler boots. Pure local: read the file, compare `latestVersion` vs running `VERSION`, delete if the running version has caught up. No network call.

### npm registry as single source of truth

We deliberately do not auto-fall-back to GitHub Releases. A tag-only release like 0.17.1 (intentionally not pushed to npm) would otherwise show up via the GH fallback as "newer" even though the canonical distribution channel hasn't moved. If the registry call fails, the JobScheduler records `lastError` on the job; the user sees it via `cfcf doctor` and the next 24h tick re-tries.

## Surfaces

### Server: `GET /api/update-status`

`packages/server/src/routes/update.ts`. Reads the flag file:
- 200 + `{ currentVersion, latestVersion, checkedAt, releaseNotesUrl? }` when the file is present AND `latestVersion > running VERSION` (the second check guards against the post-self-update race where the server has been upgraded but the scheduler hasn't yet ticked to delete the stale flag).
- 204 No Content otherwise.

The web client uses 204 specifically to avoid a JSON-parse step on the no-banner path.

### Web UI: `<UpdateBanner />`

`packages/web/src/components/UpdateBanner.tsx`. Rendered above `<Header />` in `App.tsx`. Polls `/api/update-status` once on mount and every 5 minutes after that. Per-session dismissal in `sessionStorage`, keyed by `latestVersion` so a newer release re-shows.

Cost: one HTTP call per page load, dwarfed by the dashboard's existing polling. No per-CLI-invocation cost concern applies because the web UI is a single long-lived tab.

### CLI lifecycle banner

`packages/cli/src/update-banner.ts`. Called from `packages/cli/src/index.ts` before commander parses.

Lifecycle command set: `init`, `server`, `status`, `doctor`. The bare `self-update` does NOT print the banner (its own latest-vs-current diff covers that); `self-update --check` does (the user is explicitly asking about install state).

Banner format: `⏫ cfcf v0.X.Y available; run \`cfcf self-update --yes\``. Stderr so it never contaminates stdout-based scripted use of these commands (`cfcf status --json`, `cfcf doctor --json`).

Suppression:
- `notifyUpdates: false` in the global config (`CfcfGlobalConfig.notifyUpdates`, default `true`, backfilled by `validateConfig`).
- `CFCF_NO_UPDATE_NOTICE=1` env var (one-shot suppression for scripts that want to silence the banner without touching config).

The lifecycle gate is the cheap way to avoid 5–20 ms of FS-read overhead on `cfcf run`, `cfcf clio search`, etc. Lifecycle commands are the ones a human runs interactively when paying attention to cfcf state, so the banner has the best signal-to-noise there.

### `cfcf doctor`

Adds `checkUpdateAvailable()` to the existing check list. Uses the same `defaultUpdateFilePath()` helper, so a `CFCF_UPDATE_FILE` override applies uniformly. Doctor is a snapshot — "no banner" means "scheduler hasn't seen one yet," not "no update exists."

## Config: `notifyUpdates`

Added to `CfcfGlobalConfig`:

```ts
notifyUpdates?: boolean;  // default true; backfilled by validateConfig
```

Existing installs start showing the banner once they upgrade past 0.18.0 without needing a config edit. To opt out: `cfcf config edit` → set `notifyUpdates: false`, or set `CFCF_NO_UPDATE_NOTICE=1` per-invocation.

## Test injection: `CFCF_UPDATE_FILE`

`defaultUpdateFilePath()` honours the env var so test suites can redirect the flag file out of the user's real `~/.cfcf/`. Used by `packages/server/src/routes/update.test.ts`. The CLI banner reads the env var inline (no async dependency on the core helper) for the same reason.

## Extension points for 6.13

When 6.13 lands:

1. Generalise `Job.intervalMs` to accept either a fixed interval OR a cron expression. The scheduler's per-job "is it due?" check is the only place that needs to change.
2. Add a `cfcf schedule add` CLI verb that registers user-defined jobs at runtime. The `register()` interface already supports this — what's missing is a stable on-disk representation of user jobs (the current `scheduler-state.json` only persists `lastRun` / `lastError`, not job definitions).
3. Decide on a concurrency policy. Today the tick is sequential; 6.13's representative use cases (weekly CVE sweeps, scheduled audits) might want bounded parallelism. The current single-tick design is intentionally easy to extend with a worker pool because every job is awaited in turn.

The shipped surface is deliberately the smallest seam that satisfies 6.20. Everything else is 6.13's call.
