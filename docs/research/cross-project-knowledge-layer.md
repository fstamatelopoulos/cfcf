# Cross-project knowledge layer — design research (item 5.7)

**Status:** Research draft, 2026-04-20. Not yet decided. Meant as a starting point for iteration during the week.
**Owner:** Fotis + Claude.
**Scope:** plan item `5.7` (iteration 5, currently ❌). Not a commitment to any single approach — the document surveys the design space, identifies the tensions, and sketches a few viable paths so the next session can narrow and pick one.

---

## 1. What is item 5.7?

From `docs/plan.md`:

> Cross-project knowledge — agent assessments and lessons learned accumulated across projects, with a query interface for context assembly to pull relevant prior knowledge into new projects. Needs a small memory-layer design doc first.

Concretely: today, every cfcf artifact lives **inside a single repo** (`cfcf-docs/`). If you solve a tricky problem in project A — a flaky async-test workaround, a decision about how to structure migrations, a lesson about a specific library — that knowledge stays in project A's repo. When you start project B, the dev agent spawns fresh with only project B's Problem Pack and has no way to say "we already figured out how to test this kind of async race in project A; reuse that approach."

The same is true for the judge and reflection agents — each project's `iteration-reviews/` and `reflection-reviews/` are siloed. Patterns that would be obvious with a few months of cross-project context are invisible.

Item 5.7 is about building (or integrating) a memory layer that sits **above the per-project `cfcf-docs/` files** and lets cfcf's role agents query it during context assembly.

## 2. What cfcf has today (the file-based baseline)

Repeat-information surfaces that 5.7 would sit on top of:

| File | Scope | Written by |
|---|---|---|
| `cfcf-docs/decision-log.md` | Per-project, multi-role | Dev / Judge / Architect / Reflection / User (tagged entries) |
| `cfcf-docs/iteration-logs/iteration-N.md` | Per-iteration changelog | Dev agent |
| `cfcf-docs/iteration-handoffs/iteration-N.md` | Per-iteration forward-looking notes | Dev agent (archived by cfcf) |
| `cfcf-docs/iteration-reviews/iteration-N.md` | Per-iteration judge verdict | Judge agent (archived by cfcf) |
| `cfcf-docs/reflection-reviews/reflection-N.md` | Per-iteration strategic analysis | Reflection agent (archived by cfcf) |
| `cfcf-docs/architect-review.md` + `plan.md` | Per-project | Architect agent |

All text, all committed to the project's git repo. Simple, auditable, zero infrastructure. Only downside: silos.

## 3. Requirements + non-requirements

### Requirements

- **Cross-project queries at context-assembly time.** When cfcf builds the dev/judge/architect/reflection prompt for project B, it should be able to fetch relevant prior knowledge from projects A, C, D, … and include it (or a summary of it) in the context.
- **Role-aware writes.** Each role should be able to persist learnings to the layer:
  - Dev: "library X has gotcha Y"
  - Judge: "this pattern of regression keeps appearing in auth modules"
  - Architect: "JWT auth projects usually need a refresh-token story up front"
  - Reflection: "three iterations in a row touching the same module ≈ wrong decomposition"
- **Retrieval quality that actually helps.** Keyword-only FTS is too literal for cross-project transfer ("async race in ETL" should match a project-A lesson about "concurrent pipeline ordering"). Semantic (embedding-based) retrieval is a must. Hybrid retrieval is significantly better than either alone in published RAG benchmarks; we should aim for hybrid.
- **User-owned storage.** Consistent with cfcf's "all files in the repo, no external database" spirit. Either the data stays on the user's machine, or it goes to a user-controlled backend the user explicitly opted into (e.g. their own Cerefox instance).
- **Opt-in.** cfcf must continue to work without this layer — fresh installs, users who don't want it, projects kept intentionally isolated. The file-based baseline stays as the default.
- **Agent-agnostic.** Same contract whether the dev is Claude Code, Codex, Aider, etc. Like the adapter interface for running agents, the memory layer should be invisible to the agent: it sees a file or tool result, not "a Cerefox response."

### Non-requirements (at least for the first cut)

- **Not a general-purpose KB / wiki.** The layer's job is to serve cfcf's six role agents + the user's cross-project context queries. Not "replace Obsidian."
- **Not cross-user.** Single-user installation is the target. No multi-tenant story, no per-project ACLs.
- **Not real-time / streaming.** Memory is written after commits and read at context-assembly time. Seconds-scale retrieval is fine.
- **Not a bulk-import system.** We write what cfcf's agents produce; we don't try to ingest `/usr/local/doc` or the user's Obsidian vault.
- **Not a training signal for fine-tuning.** Purely retrieval. If we later want to use accumulated data for evals or DPO, that's a separate iteration.

## 4. What the community does — a survey

The "agent memory" problem has become a well-populated design space in the last ~18 months. A few patterns worth knowing before we commit:

### 4.1 RAG on vector DBs (the baseline)

Store documents as chunks with embeddings in a vector store (Pinecone, Weaviate, Qdrant, Chroma, pgvector, Turbopuffer, LanceDB). At query time: embed the query, fetch top-k chunks by cosine similarity, include them in the prompt.

- **Strengths:** very well understood; lots of tooling (LlamaIndex, LangChain, Haystack); proven at scale.
- **Weaknesses for our case:** naive chunking loses structure; no notion of "this was decided in project A on date X"; dense-only retrieval misses exact-match cases like error strings, file names, identifiers (where BM25/FTS wins).
- **Lesson:** we want hybrid (dense + sparse), heading-aware chunking, and some structured metadata on top — all of which the state-of-the-art already does.

### 4.2 Structured agent memory frameworks

Libraries / products that are specifically "memory for agents" (not generic RAG):

- **Letta (formerly MemGPT)** — explicit memory tiers (core / episodic / archival) with an LLM-driven compaction loop. Closest academic framing to what cfcf needs (see §5.1).
- **Zep** — temporal knowledge graph over conversation turns; `zep-graphiti` adds entity-relation extraction for fact stores.
- **mem0** — lightweight OSS library: short-term (session) + long-term (user) memory with automatic summarization. Shipped as a Python/TS SDK you embed.
- **LangGraph MemorySaver / Checkpointer + LangMem** — graph-agent-level persistence + LangMem (from LangChain) for long-term learning memory over user interactions.
- **Cognee** — KG + vector hybrid; pitches itself as "semantic layer for AI agents."
- **Redis Agents (Redis AI / RedisVL)** — vector + semantic cache + session memory primitives on Redis.
- **Pinecone Assistants / vector indexes** — memory-as-a-service; commercial.

**Common shape:** ingest text → chunk → embed → store with metadata → retrieve by hybrid search at prompt time → optionally pass results through a reranker. The interesting differentiators are (a) metadata model, (b) memory lifecycle (decay, compaction, summarisation), (c) whether knowledge is extracted into a graph or stays as chunks, (d) how the agent writes back.

### 4.3 Academic framing — CoALA, episodic vs semantic

- **CoALA (Cognitive Architectures for Language Agents)** — Sumers, Yao et al., 2023–24. Formalises agent memory into four stores: *working*, *episodic* (specific past experiences), *semantic* (generalised knowledge), *procedural* (skills / tool use). Good vocabulary to reason with. For cfcf:
  - *Episodic* ≈ per-iteration logs / judge verdicts / handoffs ("on 2026-02-12 in project calc, the token-refresh test failed three ways").
  - *Semantic* ≈ generalised lessons ("token-refresh tests that use fake-timers tend to be flaky; prefer real-time yields").
  - *Procedural* ≈ reusable problem-pack / template patterns (largely item 6.8, not 5.7).
  - *Working* ≈ the `cfcf-docs/` live files during an iteration (already covered).
- **MemGPT / Letta papers** — hierarchical context with virtual context management.
- **Self-RAG / Corrective RAG** — retrieval with self-assessment of what was retrieved. Possibly relevant for the reflection agent's reading pass.
- **Generative Agents (Park et al., 2023)** — memory stream + reflection-as-summarisation pattern. Spiritually close to how cfcf's reflection role already works on per-project data; 5.7 extends that across projects.

### 4.4 Lightweight local alternatives (what small teams actually ship)

- **SQLite + vector extension** — `sqlite-vec` or `sqlite-vss`, single-file, embeddable, zero-infra. Ships inside the same binary. Works, but vector-search quality is bound by the extension's HNSW impl.
- **LanceDB** — columnar + vector, on-disk, Rust core; good Node bindings.
- **DuckDB with `vss` extension** — increasingly viable, great for analytical queries + vector hybrid.
- **Chroma in embedded mode** — "just works" Python-native but has a server mode too.
- **Qdrant in embedded mode** — same idea, Rust core, reasonable single-process footprint.

Local embedders (so we don't depend on an API):

- **all-MiniLM-L6-v2** (384d, ~23 MB) — venerable, quality-weak-but-ok, very fast, ONNX-available.
- **BGE-small / BGE-base** (384 / 768d) — better than MiniLM, BAAI's family.
- **nomic-embed-text-v1.5** (768d, long context, MIT licence) — current front-runner for open-weights embeddings.
- **mxbai-embed-large-v1** (1024d) — higher quality, bigger.
- **gte-small / gte-base** (Alibaba) — solid general-purpose alternative.
- **Ollama** exposes most of these behind a local HTTP API — low-friction if the user has Ollama already; adds a runtime dep if not.
- **Transformers.js / ONNX Runtime** — run the model in-process without Ollama. Trades complexity (shipping the model) for independence.

## 5. Options for cfcf's 5.7

Three paths worth evaluating. They're not mutually exclusive — the recommended direction (§7) involves starting with one and keeping migration open.

### 5.1 Option A — Integrate Cerefox as the cross-project memory backend

**Context:** Cerefox (the Cerefox ecosystem's knowledge-memory project, OSS) is already designed for exactly this shape of problem. From the Cerefox Solution Design doc:

> *Cerefox is a user-owned knowledge memory layer: a persistent, curated knowledge base that sits between the user and the AI tools they use. … The primary use case is shared memory across AI agents: knowledge written by one tool becomes immediately available to all others.*

Architecture highlights directly relevant here:

- **Chunks-first Postgres + pgvector** store (via Supabase). Documents are metadata envelopes; the search corpus and version history live in `cerefox_chunks`.
- **Hybrid search** — `tsvector` FTS + dense embedding search combined. `cerefox_search` (exposed as an MCP tool) returns whole documents ranked by combined relevance.
- **Small-to-big retrieval** — match on a small chunk, then pull its current siblings by `chunk_index` for full local context. Hits the sweet spot between precision (chunk-level) and coherence (passage-level).
- **Heading-aware chunking** (`heading_path`, `heading_level`) so retrieval results carry structural context.
- **Versioning** — archived chunks are preserved, excluded from search. Governance via `review_status` (`approved` / `pending_review`). Good fit for cfcf's audit-trail preferences.
- **MCP interface** — `cerefox_search`, `cerefox_ingest`, `cerefox_get_document`, `cerefox_list_projects`, etc. Already tool-shaped, which matches how agent adapters already consume external capabilities.
- **Default embedder** today: `text-embedding-3-small` (768d), with the schema set up for a second `embedding_upgrade` column so a backfill to a newer embedder can happen in-place without losing queryability.

**How cfcf would plug in:**

- Cfcf adds an optional `memoryBackend` config section: `{ kind: "cerefox", url: "...", project: "cfcf-shared" | per-project-name }`.
- **Write path:** after each successful iteration (or after reflection, or at user-specified cadences), cfcf ingests relevant artifacts to Cerefox via `cerefox_ingest`:
  - iteration-logs (as episodic memory, tagged `{ project: "X", iteration: N, role: "dev" }`)
  - reflection analyses (tagged `{ role: "reflection", health: <level> }`)
  - decision-log entries (tagged with the same `[role][iter][category]` fields we already use)
- **Read path:** at context-assembly time, each role's prompt assembler issues a `cerefox_search` for the current problem-pack topic, filtered by matching metadata (e.g. architect pulls past architect reviews tagged with similar tech stacks). Results flow into the Tier-3 "reference" section of the generated `CLAUDE.md` / `AGENTS.md`.
- **Agent-level visibility:** for agents that speak MCP natively (Claude Code does), we could also let the dev / judge / reflection agents call `cerefox_search` directly during their run — a richer integration that surfaces memory on-demand rather than only at prompt-assembly time.

**Pros:**
- Cerefox is *already* our memory substrate — dogfooding our own OSS, reducing two systems to one.
- Hybrid search + small-to-big is state-of-the-art and already implemented; we don't rebuild retrieval.
- MCP interface means Claude Code / Codex / future adapters can eventually consume memory directly, not just through cfcf's context assembler.
- Handles versioning, governance, metadata-filtered search, and human curation out of the box — things we would otherwise have to reinvent.
- Shared between cfcf and the user's other AI tools (Cursor, ChatGPT, etc.), which is Cerefox's explicit design goal.

**Cons / open questions:**
- Adds a **second server + Supabase dependency**. cfcf today is a single binary; 5.7 via Cerefox needs (a) a running Cerefox deployment and (b) either managed Supabase or a self-hosted Supabase / Postgres. "Zero-dep single binary" is no longer strictly true when this feature is on.
- **Embeddings via OpenAI** by default — API cost + key management + "knowledge about the user's projects leaks to OpenAI" concern. Cerefox does support alternate embedders, but that's a config surface the user has to navigate.
- **Cross-user / single-user ambiguity.** If the user hasn't used Cerefox before, they have to stand up an instance just for cfcf. Heavy for a "check me out" first-run.
- Every role-agent run incurs network latency (though <<<< the LLM call itself, probably negligible).

### 5.2 Option B — Standalone local memory in cfcf

Keep cfcf a single-binary story. Ship a local vector store + a local embedder so the memory layer works with zero external dependencies.

Two sub-options by vector-store choice:

#### B.1 — Embedded SQLite with `sqlite-vec`

- **Store:** a single `~/.cfcf/memory.db` SQLite file. `sqlite-vec` extension for KNN. FTS5 for the keyword half of hybrid search.
- **Embedder:** bundle a small ONNX model (e.g. `all-MiniLM-L6-v2` at 23 MB or `bge-small-en` at ~120 MB) and run it via ONNX Runtime in-process. Binary grows, but stays one file.
- **Schema:** we can crib Cerefox's chunks-first approach almost verbatim, just in SQLite. One chunks table with embedding column, FTS5 virtual table over content, metadata as JSON column with indexed keys.
- **Hybrid search:** reciprocal rank fusion over FTS5 and vector top-k. Well-understood combining method (RRF with k=60 is the standard default).

**Pros:**
- True single-binary story. `cfcf memory status` / `cfcf memory search` just work; no daemon, no ports, no auth.
- Zero API cost, zero data leaving the machine.
- Migrateable — the schema's simple enough that moving to Cerefox later is an ingest script.

**Cons:**
- Writing + maintaining retrieval code even if the foundations are borrowed. Chunking logic, metadata schema, query composition, rerank strategy — every one of those has a bunch of small decisions.
- Binary size: ONNX runtime + a 120 MB embedder model pushes the current 64 MB binary to something like 250–300 MB. We could lazily download the model on first use to keep the distributed binary small, but now first-run has a network dependency for this feature.
- Embedding quality is weaker than `text-embedding-3-small` for `all-MiniLM-L6-v2`; closer-but-still-worse for `bge-small-en`.

#### B.2 — Separate local memory sidecar

- Same idea but cfcf spawns a small companion process (say, `cfcf-memory`) that manages the DB + embedder and exposes an HTTP/MCP API on localhost.
- Pros: cleaner process boundaries, embedder doesn't bloat the main binary, can be written in Rust/Go if we want performance without pulling Node runtime into the memory path.
- Cons: more moving parts; more install story complexity; basically a miniature Cerefox but without any of the ecosystem benefits.

**Honest take:** B.2 is nearly-Cerefox-but-worse. If we're going to run a second process for memory anyway, it should probably be Cerefox. B.1 is the interesting standalone option.

### 5.3 Option C — Hybrid: local-by-default, Cerefox as an upgrade path

- cfcf ships B.1 as the default memory backend. Works offline, zero-config, user-owned.
- `memoryBackend: { kind: "cerefox", ... }` is available as an opt-in. When set, cfcf routes writes + reads to Cerefox instead of (or in addition to) the local store.
- A `cfcf memory migrate` command exports the local DB's documents as a batch ingest into Cerefox, so users who start local and decide to promote later don't lose history.

This is what I'd lean toward as a recommendation (see §7). The key design insight: both paths speak the same internal API — `memory.write(doc, metadata)` and `memory.search(query, filter)`. cfcf's role-agent context assembler doesn't know which backend is behind the interface.

## 6. Comparison matrix

| Dimension | File-only (today) | B.1 Local embedded | A. Cerefox |
|---|---|---|---|
| Zero external deps | ✅ | ✅ | ❌ (needs Cerefox + Supabase / Postgres) |
| Zero API cost | ✅ | ✅ | ⚠️ (depends on embedder config — OpenAI default) |
| Zero data-leaves-machine | ✅ | ✅ | ⚠️ (depends on embedder + backend choice) |
| Cross-project retrieval | ❌ | ✅ | ✅ |
| Hybrid search | ❌ | ✅ (RRF over FTS5 + sqlite-vec) | ✅ (Cerefox native) |
| Small-to-big retrieval | n/a | Would have to build | ✅ out of the box |
| Versioning + governance | git only | Would have to build | ✅ out of the box |
| MCP-native (agents query directly) | n/a | Would have to build | ✅ out of the box |
| Shared w/ user's other AI tools (Cursor, ChatGPT) | ❌ | ❌ | ✅ |
| Binary-size impact | 0 | +100–250 MB if model is bundled, +~5 MB if deferred | 0 (cfcf binary unchanged) |
| First-run UX | trivial | trivial | "stand up Cerefox first" |
| Migration to future richer solution | manual | scripted via `cfcf memory migrate` | n/a — already rich |
| Dogfood Cerefox | no | no | yes |

## 7. Recommended starting direction

**Ship C (hybrid) with B.1 as the first-run default, A as a one-config-flag upgrade.**

Rationale:

1. **Preserves cfcf's "just works, single binary" first-run story.** A new user tries cfcf, eventually hits the cross-project question, and gets value without standing up another service.
2. **Keeps Cerefox as the natural upgrade.** For users who already have Cerefox (Fotis and an increasing number of early adopters), flipping a config flag routes cfcf's memory to it. Knowledge pools with everything else the user stores there.
3. **Single internal API** (`memory.write`, `memory.search`) means the rest of cfcf — the six role agents' context assembly, the decision-log integration, future CLI commands like `cfcf memory search` — is backend-agnostic. We can swap or add backends without touching role code.
4. **We can ship local-first early and add Cerefox later.** Or vice versa. Or both in parallel. The spec doesn't force us to sequence one before the other.
5. **Lazy-load the embedder.** Distribute cfcf as a lean binary; on first memory use, fetch the embedder model to `~/.cfcf/models/`. Keeps the install tiny, defers the size cost to users who actually want the feature.

**Deferred / to-decide-during-implementation:**

- **Reranker?** Published hybrid-RAG benchmarks show a small cross-encoder reranker (bge-reranker-base, ~100 MB) adds meaningful quality on top of RRF fusion. Maybe v2.
- **Memory compaction / summarisation.** Raw logs accumulate; after N iterations the memory may want a periodic summarisation pass (à la Generative Agents). Probably later-stage polish.
- **Entity extraction.** Cerefox doesn't do a KG today; our own option wouldn't either. Tracking for future.
- **Per-role memory views.** Should the judge query a different slice than the dev? Likely yes (judge wants past regressions; dev wants past solutions). Solvable via metadata filters at query time; doesn't need separate stores.
- **Retention / decay policy.** Naive append-only works for a long time. Eventually we'll want "forget iteration 47 of an unrelated project" heuristics.

## 8. Open design questions

Listed here so next session can pick them off:

1. **Memory granularity.** Do we store each `iteration-log` as one document (and chunk it), or pre-decompose into smaller episodic entries (one per plan item completed)? Affects retrieval quality a lot.
2. **What gets written automatically vs on user request.** Automatic write-on-commit is the simplest (every iteration produces memory entries); user-curated ("this iteration's lesson is worth saving, the rest isn't") is higher-quality but adds UX. Maybe both: automatic by default, with a `cfcf memory forget` or "skip this" flag.
3. **Cross-project scoping.** Should the dev agent see *all* projects' memories, or only "related" ones? How do we define related — shared adapter? Shared stack tag in the Problem Pack? User-declared project groups? Start liberal (all projects), add filtering later.
4. **Does the agent see the memory, or does cfcf paraphrase?** Pasting raw retrieved chunks into CLAUDE.md is simple but adds context length. A reflection-like "synthesise the top-5 relevant memories into a 300-word note" compression pass is higher-quality but costs another LLM call. Start with raw-paste; iterate.
5. **Privacy posture.** The local option keeps everything on-machine. The Cerefox option depends on where the user's Cerefox lives. Document this clearly so users understand the tradeoff before opting in.
6. **Cfcf's own dogfooding.** As we build 5.7, cfcf's *own* repo could use it — 7 iterations of self-development are already in the decision log. Probably the best early test set.
7. **Embedder choice when Cerefox is enabled.** Cerefox defaults to `text-embedding-3-small` (OpenAI). Should cfcf surface this as a per-project toggle, or leave to Cerefox config? Likely the latter — not our concern to override.

## 9. What "ship 5.7" looks like

If we go with the §7 recommendation, the MVP is probably:

1. New `packages/core/src/memory/` subpackage: abstract `Memory` interface + `LocalMemory` impl (SQLite + sqlite-vec + FTS5 + ONNX embedder).
2. `memoryBackend` config field on `CfcfGlobalConfig` + `ProjectConfig`. Default `{ kind: "local" }` on init. `{ kind: "cerefox", url, project }` as alternative.
3. Hooks in the iteration loop: post-commit `memory.write(iterationLog, metadata)`, `memory.write(reflectionAnalysis, metadata)`, `memory.write(judgeAssessment, metadata)`.
4. Hooks in context assembly: for each role's prompt, before assembling the final `CLAUDE.md` / `AGENTS.md`, issue `memory.search(problemPack.problem, { role: <role>, max: 3 })` and paste top results into a new Tier-3 "Related prior work" section.
5. `CerefoxMemory` impl (thin MCP client) behind the same interface — swap-in for when `memoryBackend.kind === "cerefox"`.
6. `cfcf memory search <query>`, `cfcf memory stats`, `cfcf memory migrate --to cerefox --url ...` CLI commands.
7. Web UI: a Memory tab on the project detail page (showing recent entries written from this project + a text search box).

Rough scope estimate: larger than 5.1 and 5.6 combined. Likely two PRs — (a) abstract interface + local backend + agent write hooks + retrieval in context assembly, (b) Cerefox backend + migration tool + UI polish. Spread across a couple of working sessions.

## 10. Changelog

- **2026-04-20**: Initial draft. Surveys community + academic work, identifies Cerefox as a natural integration target (user's own OSS project), sketches a local-default / Cerefox-upgrade hybrid as the recommended direction.
