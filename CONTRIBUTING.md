# Contributing to cfcf

Thanks for considering a contribution! cfcf is an early-stage project
maintained by a small team — issue reports, fixes, and small
improvements are very welcome. Before opening anything large, please
follow the conventions below so we can review quickly.

## Before you start

- **Read [`docs/guides/manual.md`](docs/guides/manual.md)** to get the
  3-minute lay of the land. The same content ships in the binary as
  `cfcf help`.
- **Skim [`docs/plan.md`](docs/plan.md)** to see what's in flight + on
  the roadmap. If your idea overlaps with an in-progress item, mention
  it in the issue so we can coordinate.
- **Skim [`docs/decisions-log.md`](docs/decisions-log.md)** if you're
  proposing something architectural. Settled questions are documented
  there with their rationale; we'd rather not re-litigate them without
  new information.

## How to report a bug

Open an issue with:

1. **What you tried** — the exact command(s) + the workspace setup
2. **What you expected** — the behaviour you anticipated
3. **What happened** — actual output, error messages, relevant stderr
4. **Environment** — `cfcf doctor --json` output (it dumps the install
   state) + Bun version + OS

The doctor output is enough for us to reproduce most install/setup
issues without further round-trips. For loop / agent issues, also
include the workspace's `cfcf-docs/iteration-history.md` if not
sensitive.

If the bug is a security issue, see [`SECURITY.md`](SECURITY.md) — do
not open a public issue.

## How to suggest a feature

Open an issue first, before writing code, with:

1. **What problem you're trying to solve** — the user-facing pain, not
   the implementation
2. **Why existing functionality doesn't cover it**
3. **What you'd propose** — sketch the API / CLI surface; we'll iterate
   on the design before any code lands

cfcf has strong design principles ([`CLAUDE.md`](CLAUDE.md) → "Key
Design Principles") — proposals that conflict with those will need
extra justification.

## How to submit a fix

1. **Open an issue first** unless the fix is obvious (typo, broken
   link, single-line bug). For non-trivial changes, the design
   conversation belongs in the issue, not in the PR diff.
2. **Branch from `main`**: `git checkout -b fix/<short-description>`.
3. **Keep PRs focused.** One concern per PR. Multiple fixes go in
   multiple PRs.
4. **Run the test suite + typecheck before pushing**:
   ```bash
   bun run typecheck
   bun run test
   ```
   Both must pass. CI runs the same commands.
5. **Update tests.** Every behavioural change should have a test that
   would have caught the bug or that pins the new behaviour.
6. **Update docs.** If you change a CLI flag, an API endpoint, or a
   config key, update the relevant guide under `docs/guides/`. If your
   change affects the architecture, mention it in
   `docs/decisions-log.md`.
7. **Write a tight commit message + PR description.** What changed +
   why, briefly. The PR body is read by future-you debugging a
   regression in 6 months.

## Code style

- **TypeScript**, strict. No `any` without a comment explaining why.
- **Bun runtime APIs are fair game** (`bun:sqlite`, `Bun.spawn`,
  `Bun.file`) — cfcf requires Bun ≥ 1.3.
- **Tests are colocated**: `foo.ts` → `foo.test.ts`.
- **Follow existing patterns.** Look at the package(s) you're touching;
  match their style for naming, error handling, comments. Drift hurts
  reviewability more than novelty helps.
- **Comments explain `why`, not `what`.** The diff already shows what
  changed; the comment should record reasoning that won't be in the
  diff.

## Conventions

- **Branch names**: `fix/<topic>`, `feat/<topic>`, `docs/<topic>`.
- **Commit messages**: imperative mood, ≤ 72 chars on the subject line,
  body wraps at 72 chars and explains why. Example commits in `git log`
  show the house style.
- **PR titles**: same style as commit subject lines.

## What gets merged quickly

- Bug fixes with a regression test
- Doc fixes (typos, broken links, clarifications)
- Small refactors that reduce complexity
- New tests covering existing untested behaviour

## What needs more discussion

- New top-level CLI verbs
- Changes to the iteration loop's commit / branch / signal-file model
- New required dependencies (especially native ones)
- Schema changes to Clio (`packages/core/src/clio/migrations/`)
- Anything touching agent adapter contracts (`packages/core/src/types.ts`)

For the above, please open an issue or design-doc PR before
implementing.

## License

By contributing, you agree your contribution is licensed under
[Apache License 2.0](LICENSE), the same license cfcf ships under.
