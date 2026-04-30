# Security policy

## Reporting a vulnerability

If you discover a security issue in cfcf — anything that could compromise a
user's machine, leak credentials, escalate privileges, or be exploited
remotely — **please report it privately first**, not via a public issue.

The fastest path is GitHub's private vulnerability reporting:

1. Go to <https://github.com/fstamatelopoulos/cfcf/security/advisories/new>
2. Describe the issue + reproducer
3. We'll acknowledge within **3 business days** and discuss disclosure timing
   with you before anything goes public

If you can't use GitHub's flow for any reason, email **fotis@innovedi.com**
with `[cfcf security]` in the subject line.

We don't run a bug bounty. We do credit reporters in the changelog (with
their consent) once a fix ships.

## What's in scope

cfcf is an orchestration harness, not a network service. The realistic
attack surfaces are:

- **The local Hono server** (default port `7233`, bound to `127.0.0.1`).
  Anything that lets a non-localhost caller reach the API, or that lets a
  localhost caller escalate beyond the cfcf user's privileges.
- **Agent process management**. cfcf spawns AI agent CLIs as child
  processes; anything that lets a malicious Problem Pack or workspace
  inject command arguments or exfiltrate files outside the workspace.
- **Clio memory layer**. Anything that lets one workspace's content
  surface in another workspace's queries when project scoping should
  prevent it.
- **The npm-published packages** (`@cerefox/codefactory`,
  `@cerefox/codefactory-native-*`). Anything that lets a published
  tarball escape the standard `bun install -g` install path or run
  unexpected code outside the documented `postinstall` step.
- **The release pipeline** (`.github/workflows/release.yml`). Anything
  that lets an unauthorised actor publish to npm, modify a GitHub
  Release, or otherwise tamper with the supply chain.

## What's out of scope

- Your local environment compromised by an attacker who already has shell
  access (cfcf trusts the user it runs as).
- Behaviour of upstream agent CLIs (Claude Code, Codex). Report those to
  the respective vendors.
- Behaviour of underlying runtime libraries (Bun, ONNX Runtime, sharp,
  transformers, sqlite-vec). Report those upstream.
- The trust model of running AI-authored code. cfcf executes code agents
  produce; if you're worried about that, gate cfcf behind a sandbox of
  your choice (Docker, devcontainers, VMs).

## Supported versions

Only the latest released version of cfcf gets security fixes. Older
versions are not back-patched. If a CVE affects a version you're running,
upgrade with `cfcf self-update` or `bun install -g @cerefox/codefactory`.

## Coordinated disclosure

We follow standard 90-day coordinated disclosure. If a fix is taking
longer than 90 days for legitimate reasons (e.g., depends on an upstream
patch), we'll discuss extension with the reporter.
