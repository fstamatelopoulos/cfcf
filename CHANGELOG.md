# Changelog

All notable changes to cfcf (cf²) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Changes are tracked via git tags. Each release tag corresponds to an entry here.

## [Unreleased]

## [0.0.0] -- 2026-04-11

Iteration 0: Project scaffolding, server skeleton, CLI, first-run configuration.

### Added
- Bun monorepo with `@cfcf/core`, `@cfcf/server`, `@cfcf/cli` workspace packages
- Hono-based HTTP server with `/api/health`, `/api/status`, `/api/config` endpoints
- Commander.js CLI with `cfcf init`, `cfcf status`, `cfcf server start/stop/status`
- First-run interactive configuration: agent detection, user prompts, permission acknowledgment
- Agent adapter interface with Claude Code and Codex CLI adapters
- Platform-specific config storage (XDG on Linux, Application Support on macOS, AppData on Windows)
- 35 tests (74 assertions) covering core config, adapters, server API, and CLI client
- Project documentation suite: requirements & vision (v0.4), tech stack, technical design, agent process & context, development plan, server API reference
- CLAUDE.md with project principles for AI coding agents
- docs/ structure: design/, api/, research/, guides/

[Unreleased]: https://github.com/fstamatelopoulos/cfcf/compare/v0.0.0...HEAD
[0.0.0]: https://github.com/fstamatelopoulos/cfcf/releases/tag/v0.0.0
