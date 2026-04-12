# Changelog

All notable changes to cfcf (cf²) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Changes are tracked via git tags. Each release tag corresponds to an entry here.

## [Unreleased]

### Added
- Monorepo structure with `@cfcf/core`, `@cfcf/server`, `@cfcf/cli` packages
- Hono-based server with health, status, and config API endpoints
- CLI with `cfcf init`, `cfcf status`, `cfcf server start/stop/status` commands
- First-run interactive configuration: agent detection, user prompts, permission acknowledgment
- Agent adapter interface with Claude Code and Codex CLI adapters
- Platform-specific config storage (XDG on Linux, Application Support on macOS, AppData on Windows)
- Test suite with 35 tests covering core, server API, and CLI client
- Project documentation: requirements & vision, technical design, agent process & context, development plan
