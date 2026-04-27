/**
 * `cfcf clio <verb>` -- Clio memory layer CLI.
 *
 * Surface (locked 2026-04-27 in `docs/research/cli-verb-normalisation.md`):
 *   - Top-level (collection-wide / Clio-wide / headline):
 *       search | audit | reindex | stats
 *   - `docs` namespace (operates on a doc-instance):
 *       list | ingest | get | edit | delete | restore | versions
 *   - `metadata` namespace (sub-concept with multiple operations):
 *       search | keys
 *   - `projects` namespace (one-per-project):
 *       list | create | show
 *   - `embedder` namespace (one-per-embedder; singular: only one active):
 *       list | active | install | set
 *
 * `cfcf memory` is a top-level alias that points at the same command tree.
 *
 * The verb-or-namespace decision follows the three-clause rule in
 * `cli-verb-normalisation.md` §4.1; the rule is mechanical, so future
 * verbs can be placed without judgement calls.
 */

import type { Command } from "commander";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { isServerReachable, post, get, del, patch } from "../client.js";
import { createInterface } from "node:readline";
import { DEFAULT_EMBEDDER_NAME } from "@cfcf/core";
import type {
  ClioProject,
  ClioDocument,
  ClioDocumentVersion,
  ClioAuditEntry,
  IngestResult,
  SearchResponse,
  SearchHit,
  DocumentSearchResponse,
  DocumentSearchHit,
  ClioStats,
} from "@cfcf/core";

interface DocumentContentResponse {
  document: ClioDocument;
  content: string;
  chunkCount: number;
  totalChars: number;
  versionId: string | null;
}

interface VersionsResponse {
  versions: ClioDocumentVersion[];
}

interface AuditLogResponse {
  entries: ClioAuditEntry[];
}

interface ClioProjectListResponse {
  projects: ClioProject[];
}

export function registerClioCommands(program: Command): void {
  registerUnder(program.command("clio").description("Clio memory layer: search + ingest across workspaces"));
  // Alias: `cfcf memory <verb>` routes to the same handlers. Users who type
  // "memory" naturally land on the feature without needing to remember the
  // codename.
  registerUnder(program.command("memory").description("Alias for `cfcf clio`"));
}

function registerUnder(root: Command): void {
  // ── Namespace command groups ──────────────────────────────────────────
  // The four Clio nouns each get their own namespace. Verbs that operate
  // on a specific instance of a noun (or create one) live under the
  // namespace; collection-wide / Clio-wide verbs (search, audit, reindex,
  // stats) stay top-level. See `docs/research/cli-verb-normalisation.md`
  // §4.1 for the three-clause rule that decides namespace-or-not.
  //
  // Declared up-front so every subcommand registration below can attach
  // to the right parent without forward-reference gymnastics.
  const docsCmd = root
    .command("docs")
    .description("Document operations: list / get / ingest / edit / delete / restore / versions. Default action: list.");
  const metadataCmd = root
    .command("metadata")
    .description("Metadata-only operations: filter docs by metadata; discover metadata keys. (No default subcommand: `cfcf clio metadata` prints help.)");
  const projectsCmd = root
    .command("projects")
    .description("Clio Projects: list / create / show. Default action: list.");
  const embedderCmd = root
    .command("embedder")
    .description("Embedder: list / active / install / set");

  // ── search ────────────────────────────────────────────────────────────
  root
    .command("search <query...>")
    .description(
      "Search Clio for documents matching <query>. Mode resolution order: " +
      "explicit --mode > clio.defaultSearchMode in global config > 'auto' " +
      "(hybrid if an embedder is active, fts otherwise).",
    )
    .option("-p, --project <name>", "Scope to a single Clio Project (name or id)")
    .option(
      "--mode <mode>",
      "Search mode: 'fts' (keyword), 'semantic' (vector cosine), or 'hybrid' (RRF over both). Omit to use the configured default.",
    )
    .option(
      "--min-score <n>",
      "Minimum cosine (0.0-1.0) for vector-only hybrid candidates / all semantic results. FTS-matched hybrid chunks always pass. Omit to use clio.minSearchScore from config (default 0.5).",
      (v) => parseFloat(v),
    )
    .option(
      "--alpha <n>",
      "Hybrid-search blend weight (0.0-1.0). α × cosine + (1-α) × normalised_BM25. Higher = more semantic; lower = more keyword. Omit to use clio.hybridAlpha (default 0.7, Cerefox parity).",
      (v) => parseFloat(v),
    )
    .option(
      "--small-doc-threshold <chars>",
      "Doc-level: docs ≤ this size return FULL content per hit (Cerefox parity). Larger docs return matched chunk + neighbours. Omit to use clio.smallDocThreshold (default 20000). Set 0 to always use chunk+neighbours.",
      (v) => parseInt(v, 10),
    )
    .option(
      "--context-window <n>",
      "Doc-level large-doc path: chunks per side around the matched chunk. Omit to use clio.contextWindow (default 1). Cerefox parity.",
      (v) => parseInt(v, 10),
    )
    .option(
      "-n, --match-count <n>",
      "Max results to return (doc-level default 5; --by-chunk default 10).",
      (v) => parseInt(v, 10),
    )
    .option(
      "-m, --metadata <json>",
      "Exact-match metadata filter, e.g. '{\"role\":\"reflection\",\"artifact_type\":\"reflection-analysis\"}'",
    )
    .option(
      "--by-chunk",
      "Show one row per matching CHUNK (raw view) instead of the default doc-level dedup. Useful for debugging the search engine; agents typically want the doc-level default.",
    )
    .option("--json", "Emit the raw JSON response instead of the human-readable formatting")
    .action(async (queryParts: string[], opts) => {
      if (!(await checkServer())) return;

      const q = queryParts.join(" ").trim();
      if (!q) {
        console.error("search: query is empty");
        process.exit(1);
      }

      const qs = new URLSearchParams();
      qs.set("q", q);
      if (opts.project) qs.set("project", opts.project);
      if (opts.mode) {
        if (!["fts", "semantic", "hybrid"].includes(opts.mode)) {
          console.error(`search: --mode must be one of fts | semantic | hybrid (got: ${opts.mode})`);
          process.exit(1);
        }
        qs.set("mode", opts.mode);
      }
      if (opts.minScore !== undefined) {
        if (isNaN(opts.minScore) || opts.minScore < 0 || opts.minScore > 1) {
          console.error(`search: --min-score must be a number in [0, 1] (got: ${opts.minScore})`);
          process.exit(1);
        }
        qs.set("min_score", String(opts.minScore));
      }
      if (opts.alpha !== undefined) {
        if (isNaN(opts.alpha) || opts.alpha < 0 || opts.alpha > 1) {
          console.error(`search: --alpha must be a number in [0, 1] (got: ${opts.alpha})`);
          process.exit(1);
        }
        qs.set("alpha", String(opts.alpha));
      }
      if (opts.smallDocThreshold !== undefined) {
        if (isNaN(opts.smallDocThreshold) || opts.smallDocThreshold < 0) {
          console.error(`search: --small-doc-threshold must be a non-negative integer`);
          process.exit(1);
        }
        qs.set("small_doc_threshold", String(opts.smallDocThreshold));
      }
      if (opts.contextWindow !== undefined) {
        if (isNaN(opts.contextWindow) || opts.contextWindow < 0) {
          console.error(`search: --context-window must be a non-negative integer`);
          process.exit(1);
        }
        qs.set("context_window", String(opts.contextWindow));
      }
      if (opts.matchCount) qs.set("match_count", String(opts.matchCount));
      if (opts.metadata) {
        try {
          JSON.parse(opts.metadata);
        } catch {
          console.error("search: --metadata must be valid JSON");
          process.exit(1);
        }
        qs.set("metadata", opts.metadata);
      }

      // Doc-level (default, Cerefox parity) vs chunk-level (--by-chunk).
      const by: "doc" | "chunk" = opts.byChunk ? "chunk" : "doc";
      qs.set("by", by);

      if (by === "chunk") {
        const res = await get<SearchResponse>(`/api/clio/search?${qs.toString()}`);
        if (!res.ok) {
          console.error(`Search failed: ${res.error}`);
          process.exit(1);
        }
        const data = res.data!;
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        if (data.hits.length === 0) {
          console.log(`No hits for "${q}".`);
          return;
        }
        console.log(`${data.hits.length} chunk-hit(s) for "${q}" (${data.mode}):`);
        console.log();
        data.hits.forEach((h, i) => printHit(i + 1, h));
        return;
      }

      // Doc-level (the new default).
      const res = await get<DocumentSearchResponse>(`/api/clio/search?${qs.toString()}`);
      if (!res.ok) {
        console.error(`Search failed: ${res.error}`);
        process.exit(1);
      }
      const data = res.data!;
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      if (data.hits.length === 0) {
        console.log(`No hits for "${q}".`);
        return;
      }
      const totalsHint = data.totalDocuments > data.hits.length
        ? `  (showing top ${data.hits.length} of ${data.totalDocuments} matching docs; pass --match-count to widen)`
        : "";
      console.log(`${data.hits.length} doc-hit(s) for "${q}" (${data.mode})${totalsHint}:`);
      console.log();
      data.hits.forEach((h, i) => printDocHit(i + 1, h));
    });

  // ── docs: ingest ──────────────────────────────────────────────────────
  // Creates a doc-instance (or updates with --document-id / --update-if-exists);
  // operates on a doc-as-a-noun, so lives under the `docs` namespace.
  docsCmd
    .command("ingest [file]")
    .description(
      "Ingest a Markdown document into Clio. Pass a file path, or use --stdin to pipe via stdin.",
    )
    .option("--stdin", "Read content from stdin instead of a file")
    .option("-p, --project <name>", "Clio Project to ingest into (auto-created if missing)", "default")
    .option("-t, --title <title>", "Document title. Defaults to the file name (or 'stdin' for piped)")
    .option("--source <src>", "Free-text origin hint (default: file path or 'stdin')")
    .option(
      "--artifact-type <type>",
      "Metadata: artifact_type (e.g. design-guideline, domain-knowledge, research-note, adr, note)",
    )
    .option("--tier <tier>", "Metadata: tier (episodic | semantic)")
    .option("--tags <csv>", "Metadata: comma-separated tag list")
    .option(
      "--metadata <json>",
      "Additional metadata as JSON, merged over the other --* metadata fields",
    )
    .option(
      "--update-if-exists",
      "If a live document with the same title already exists in this Project, update it in place (snapshot the prior content as a version) instead of creating a new doc. Mirrors Cerefox `cerefox_ingest(update_if_exists=true)`.",
    )
    .option(
      "--document-id <uuid>",
      "Update this specific document by UUID (deterministic update). Errors if the document doesn't exist. Wins over --update-if-exists if both passed. Mirrors Cerefox `cerefox_ingest(document_id=...)`.",
    )
    .option(
      "--author <name>",
      "Who/what is making this write (e.g. 'claude-code', 'archiver'). Stored on the version row when an update happens; surfaced by `cfcf clio docs versions <doc-id>`. Defaults to 'agent'.",
    )
    .option("--json", "Emit the raw JSON result instead of a human-readable summary")
    .action(async (file: string | undefined, opts) => {
      if (!(await checkServer())) return;

      let content: string;
      let defaultTitle: string;
      let defaultSource: string;
      if (opts.stdin) {
        content = await readStdin();
        defaultTitle = "stdin";
        defaultSource = "stdin";
      } else {
        if (!file) {
          console.error("ingest: pass a file path or use --stdin");
          process.exit(1);
        }
        const path = resolve(file);
        try {
          content = await readFile(path, "utf-8");
        } catch (err: unknown) {
          console.error(`ingest: could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
        defaultTitle = file.split("/").pop() ?? file;
        defaultSource = `user-ingest: ${path}`;
      }

      // 5.11 follow-up: on `--document-id` update, send the title as
      // undefined when the user didn't explicitly pass `--title`. The
      // server preserves the existing doc's title in that case rather
      // than overwriting with the file-basename default. For create
      // paths + --update-if-exists, the title is the lookup key (or
      // the new doc's identity), so we still send a default.
      const titleExplicit = opts.title !== undefined;
      const title = titleExplicit
        ? opts.title
        : opts.documentId
          ? undefined        // preserve existing on UUID-keyed update
          : defaultTitle;    // file basename for create / title-keyed update
      const source = opts.source || defaultSource;

      // Build metadata from individual flags + --metadata JSON.
      const metadata: Record<string, unknown> = {};
      if (opts.artifactType) metadata.artifact_type = opts.artifactType;
      if (opts.tier) metadata.tier = opts.tier;
      if (opts.tags) metadata.tags = String(opts.tags).split(",").map((t) => t.trim()).filter(Boolean);
      if (opts.metadata) {
        try {
          Object.assign(metadata, JSON.parse(opts.metadata));
        } catch {
          console.error("ingest: --metadata must be valid JSON");
          process.exit(1);
        }
      }
      // Every user/agent-driven ingest gets origin=user-cli so cf²-auto
      // ingests can be filtered separately in downstream queries.
      if (!metadata.origin) metadata.origin = "user-cli";

      // Ingest can take several seconds when an embedder is active (the
      // server runs embedder.embed() over every chunk synchronously
      // before returning). Show a spinner so the UX doesn't feel stuck.
      // Suppressed in --json mode + non-TTY stderr.
      //
      // `title` may be undefined here (the title-preservation case for
      // --document-id updates without an explicit --title; see above).
      // Use the file basename / "stdin" placeholder for the spinner
      // label only -- the actual request still sends `undefined` so
      // the server preserves the existing doc's title.
      const labelTitle = title ?? defaultTitle;
      const titleSnippet = labelTitle.length > 40 ? labelTitle.slice(0, 37) + "…" : labelTitle;
      const stopSpinner = startSpinner({
        label: `ingesting "${titleSnippet}" (${formatBytes(content.length)})`,
        enable: !opts.json && !!process.stderr.isTTY,
      });
      const res = await post<IngestResult>("/api/clio/ingest", {
        project: opts.project,
        title,
        content,
        source,
        metadata,
        updateIfExists: opts.updateIfExists ? true : undefined,
        documentId: opts.documentId,
        author: opts.author,
      });
      stopSpinner();
      if (!res.ok) {
        console.error(`Ingest failed: ${res.error}`);
        process.exit(1);
      }
      const data = res.data!;

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      const chunksLabel = `${data.chunksInserted} chunk${data.chunksInserted === 1 ? "" : "s"}`;
      const ingestProjectLabel = data.document.projectName
        ? `${data.document.projectName} [${data.document.projectId}]`
        : data.document.projectId;
      switch (data.action) {
        case "created":
          console.log(`Ingested: ${data.document.title} (${chunksLabel})`);
          console.log(`  id:      ${data.id}`);
          console.log(`  project: ${ingestProjectLabel}`);
          console.log(`  source:  ${data.document.source}`);
          break;
        case "updated":
          console.log(`Updated: ${data.document.title} (${chunksLabel}, prior version v${data.versionNumber})`);
          console.log(`  id:           ${data.id}`);
          console.log(`  project:      ${ingestProjectLabel}`);
          console.log(`  prior version_id: ${data.versionId}`);
          console.log(`  Recall the prior content via:`);
          console.log(`    cfcf clio docs get ${data.id} --version-id ${data.versionId}`);
          break;
        case "skipped":
          console.log(`Already in Clio (content_hash match): ${data.document.title}`);
          console.log(`  id:      ${data.id}`);
          console.log(`  Use --update-if-exists or --document-id <uuid> to overwrite.`);
          break;
      }
      if (data.note) {
        console.log(`  note: ${data.note}`);
      }
    });

  // ── docs: get ─────────────────────────────────────────────────────────
  // Reconstructs the full document content from its chunks. Default =
  // the live (current) version; pass --version-id <uuid> to retrieve an
  // archived version (UUIDs come from `cfcf clio docs versions <doc-id>`).
  docsCmd
    .command("get <id>")
    .description("Retrieve a Clio document by id (reconstructs full content from chunks)")
    .option(
      "--version-id <uuid>",
      "Retrieve a specific archived version (default: live/current). UUID comes from `cfcf clio docs versions <id>`.",
    )
    .option("--raw", "Print only the reconstructed content (skip the metadata header)")
    .option("--json", "Print the full {document, content, ...} response as JSON")
    .action(async (id: string, opts) => {
      if (!(await checkServer())) return;
      const qs = new URLSearchParams();
      if (opts.versionId) qs.set("version_id", opts.versionId);
      const path = qs.toString()
        ? `/api/clio/documents/${encodeURIComponent(id)}/content?${qs.toString()}`
        : `/api/clio/documents/${encodeURIComponent(id)}/content`;
      const res = await get<DocumentContentResponse>(path);
      if (!res.ok) {
        console.error(`Not found: ${id}${opts.versionId ? ` (version ${opts.versionId})` : ""}`);
        process.exit(1);
      }
      const data = res.data!;
      const doc = data.document;
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      if (opts.raw) {
        // Pure content; useful for `cfcf clio docs get <id> | sed ...` agent workflows.
        process.stdout.write(data.content);
        if (!data.content.endsWith("\n")) process.stdout.write("\n");
        return;
      }
      const getProjectLabel = doc.projectName
        ? `${doc.projectName} [${doc.projectId}]`
        : doc.projectId;
      console.log(`# ${doc.title}`);
      console.log();
      console.log(`  id:            ${doc.id}`);
      console.log(`  project:       ${getProjectLabel}`);
      console.log(`  source:        ${doc.source}`);
      console.log(`  content_hash:  ${doc.contentHash}`);
      console.log(`  review_status: ${doc.reviewStatus}`);
      console.log(`  chunks:        ${data.chunkCount}`);
      console.log(`  total_chars:   ${data.totalChars}`);
      console.log(`  created_at:    ${doc.createdAt}`);
      console.log(`  updated_at:    ${doc.updatedAt}`);
      console.log(`  version:       ${data.versionId ? `archived (${data.versionId})` : "live (current)"}`);
      if (doc.metadata && Object.keys(doc.metadata).length > 0) {
        console.log(`  metadata:`);
        for (const [k, v] of Object.entries(doc.metadata)) {
          console.log(`    ${k}: ${JSON.stringify(v)}`);
        }
      }
      console.log();
      console.log("--- content ---");
      console.log(data.content);
    });

  // ── docs: versions ────────────────────────────────────────────────────
  // List archived versions for a document. Empty for docs that have
  // never been updated. Mirrors Cerefox `cerefox_list_versions`.
  docsCmd
    .command("versions <id>")
    .description("List archived versions for a Clio document (newest first)")
    .option("--json", "Emit raw JSON")
    .action(async (id: string, opts) => {
      if (!(await checkServer())) return;
      const res = await get<VersionsResponse>(`/api/clio/documents/${encodeURIComponent(id)}/versions`);
      if (!res.ok) {
        console.error(`Not found: ${id}`);
        process.exit(1);
      }
      const versions = res.data!.versions;
      if (opts.json) {
        console.log(JSON.stringify(versions, null, 2));
        return;
      }
      if (versions.length === 0) {
        console.log(`No archived versions for ${id}.`);
        console.log("(A document only gets versions after it's been updated. Try ingesting with --update-if-exists or --document-id.)");
        return;
      }
      console.log(`${versions.length} version(s) for ${id} (newest first):`);
      console.log();
      for (const v of versions) {
        console.log(`  v${v.versionNumber}  ${v.createdAt}  ${v.chunkCount} chunks, ${v.totalChars} chars`);
        if (v.source) console.log(`       source: ${v.source}`);
        console.log(`       version_id: ${v.id}`);
        console.log(`       Recall via: cfcf clio docs get ${id} --version-id ${v.id}`);
      }
    });

  // ── audit ────────────────────────────────────────────────────────────
  // Read-only view of clio_audit_log. Mirrors Cerefox `cerefox_get_audit_log`.
  // Reads (search, get, list) are NOT recorded -- only mutations.
  root
    .command("audit")
    .description("Query the Clio audit log (newest first). All filters AND together.")
    .option("--event-type <type>", "create | update-content | delete | restore | migrate-project")
    .option("--actor <name>", "Exact match on actor (e.g. 'claude-code')")
    .option("-p, --project <name>", "Scope to a single Clio Project")
    .option("--document-id <uuid>", "Audit history for one document")
    .option("--since <iso>", "Only entries with timestamp >= this ISO-8601 timestamp")
    .option("-n, --limit <n>", "Max entries to return (default 100, max 1000)", (v) => parseInt(v, 10))
    .option("--json", "Emit raw JSON")
    .action(async (opts) => {
      if (!(await checkServer())) return;
      const qs = new URLSearchParams();
      if (opts.eventType) qs.set("event_type", opts.eventType);
      if (opts.actor) qs.set("actor", opts.actor);
      if (opts.project) qs.set("project", opts.project);
      if (opts.documentId) qs.set("document_id", opts.documentId);
      if (opts.since) qs.set("since", opts.since);
      if (opts.limit) qs.set("limit", String(opts.limit));
      const url = qs.toString() ? `/api/clio/audit-log?${qs.toString()}` : "/api/clio/audit-log";
      const res = await get<AuditLogResponse>(url);
      if (!res.ok) {
        console.error(`audit failed: ${res.error}`);
        process.exit(1);
      }
      const entries = res.data!.entries;
      if (opts.json) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }
      if (entries.length === 0) {
        console.log("No audit entries match the filter.");
        return;
      }
      console.log(`${entries.length} audit entry(ies), newest first:`);
      console.log();
      for (const e of entries) {
        console.log(`  [${e.timestamp}] ${e.eventType}  actor=${e.actor ?? "?"}`);
        if (e.documentId) console.log(`     [id: ${e.documentId}]`);
        if (e.projectId) console.log(`     project: ${e.projectId}`);
        if (e.metadata && Object.keys(e.metadata).length > 0) {
          for (const [k, v] of Object.entries(e.metadata)) {
            console.log(`     ${k}: ${JSON.stringify(v)}`);
          }
        }
      }
    });

  // ── metadata: search ─────────────────────────────────────────────────
  // Find documents by metadata only (no FTS query). Supports a JSON
  // metadata filter and an optional updated_since timestamp for the
  // catch-up workflow. Mirrors Cerefox `cerefox_metadata_search`.
  metadataCmd
    .command("search")
    .description("Find Clio documents by metadata-only filter (no FTS query). Top-level scalar matches.")
    .requiredOption(
      "--filter <json>",
      "Metadata filter as JSON, e.g. '{\"role\":\"reflection\",\"artifact_type\":\"reflection-analysis\"}'",
    )
    .option("-p, --project <name>", "Scope to a single Clio Project (name or id)")
    .option(
      "--updated-since <iso>",
      "Only return docs whose updated_at >= this ISO-8601 timestamp (e.g. '2026-04-01T00:00:00Z')",
    )
    .option("--include-deleted", "Include soft-deleted docs")
    .option("-n, --match-count <n>", "Max docs to return (default 50, max 500)", (v) => parseInt(v, 10))
    .option("--json", "Emit raw JSON")
    .action(async (opts) => {
      if (!(await checkServer())) return;
      let metadataFilter: Record<string, string | number | boolean>;
      try {
        metadataFilter = JSON.parse(opts.filter);
        if (!metadataFilter || typeof metadataFilter !== "object" || Array.isArray(metadataFilter)) {
          throw new Error("filter must be a JSON object");
        }
      } catch (err) {
        console.error(`metadata-search: --filter must be valid JSON object (got: ${opts.filter}). ${err instanceof Error ? err.message : ""}`);
        process.exit(1);
      }
      const body = {
        metadataFilter,
        project: opts.project,
        updatedSince: opts.updatedSince,
        includeDeleted: opts.includeDeleted ? true : undefined,
        matchCount: opts.matchCount,
      };
      const res = await post<{
        documents: ClioDocument[];
        metadataFilter: Record<string, unknown>;
      }>("/api/clio/metadata-search", body);
      if (!res.ok) {
        console.error(`metadata-search failed: ${res.error}`);
        process.exit(1);
      }
      const docs = res.data!.documents;
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      if (docs.length === 0) {
        console.log("No documents match the filter.");
        return;
      }
      console.log(`${docs.length} document(s) match ${JSON.stringify(metadataFilter)}:`);
      console.log();
      for (const d of docs) {
        const projectLabel = d.projectName
          ? `${d.projectName} [${d.projectId}]`
          : d.projectId;
        console.log(`  ${d.title}`);
        console.log(`     [id: ${d.id}]  author: ${d.author}`);
        console.log(`     project: ${projectLabel}`);
        console.log(`     updated: ${d.updatedAt}`);
        if (d.deletedAt) console.log(`     deleted_at: ${d.deletedAt}`);
        console.log();
      }
    });

  // ── metadata: keys ───────────────────────────────────────────────────
  // Discovery: what metadata keys exist in the corpus, with sample values.
  // Mirrors Cerefox `cerefox_list_metadata_keys`. Useful for agents
  // figuring out "what filters can I apply?" before crafting a query.
  metadataCmd
    .command("keys")
    .description("List metadata keys + sample values currently in Clio (most-used first)")
    .option("-p, --project <name>", "Scope to a single Clio Project (name or id)")
    .option("--json", "Emit raw JSON")
    .action(async (opts) => {
      if (!(await checkServer())) return;
      const qs = opts.project ? `?project=${encodeURIComponent(opts.project)}` : "";
      const res = await get<{
        keys: { key: string; documentCount: number; valueSamples: unknown[] }[];
      }>(`/api/clio/metadata-keys${qs}`);
      if (!res.ok) {
        console.error(`metadata-keys failed: ${res.error}`);
        process.exit(1);
      }
      const keys = res.data!.keys;
      if (opts.json) {
        console.log(JSON.stringify(keys, null, 2));
        return;
      }
      if (keys.length === 0) {
        console.log("No metadata keys found.");
        return;
      }
      console.log(`${keys.length} metadata key(s) (most-used first):`);
      console.log();
      for (const k of keys) {
        const samples = k.valueSamples.length ? `  samples: ${k.valueSamples.map((v) => JSON.stringify(v)).join(", ")}` : "";
        console.log(`  ${k.key}  (${k.documentCount} doc${k.documentCount === 1 ? "" : "s"})${samples}`);
      }
    });

  // ── docs: delete (soft-delete) ────────────────────────────────────────
  // Mirrors Cerefox `cerefox_delete_document`. Sets deleted_at; the
  // doc, its chunks, and its versions remain in the DB so a subsequent
  // `cfcf clio docs restore <id>` can undo it. Search + listDocuments
  // exclude soft-deleted docs by default.
  docsCmd
    .command("delete <id>")
    .description("Soft-delete a Clio document (excludes from search; restorable via `cfcf clio docs restore <id>`)")
    .option("--author <name>", "Who is performing this delete (audit attribution; defaults to 'agent')")
    .action(async (id: string, opts) => {
      if (!(await checkServer())) return;
      const res = await del<{ deleted: boolean; document: ClioDocument | null }>(
        `/api/clio/documents/${encodeURIComponent(id)}`,
        opts.author ? { author: opts.author } : undefined,
      );
      if (!res.ok) {
        console.error(`Delete failed: ${res.error}`);
        process.exit(1);
      }
      console.log(`Soft-deleted: ${id}`);
      console.log(`  Restore with: cfcf clio docs restore ${id}`);
    });

  // ── docs: restore ─────────────────────────────────────────────────────
  // Undo a soft-delete. Idempotent: restoring an already-live doc is
  // a no-op (returns restored=false). Mirrors Cerefox
  // `cerefox_restore_document`.
  docsCmd
    .command("restore <id>")
    .description("Restore a soft-deleted Clio document")
    .option("--author <name>", "Who is performing this restore (audit attribution)")
    .action(async (id: string, opts) => {
      if (!(await checkServer())) return;
      const res = await post<{ restored: boolean; document: ClioDocument | null }>(
        `/api/clio/documents/${encodeURIComponent(id)}/restore`,
        opts.author ? { author: opts.author } : undefined,
      );
      if (!res.ok) {
        console.error(`Restore failed: ${res.error}`);
        process.exit(1);
      }
      const data = res.data!;
      if (data.restored) {
        console.log(`Restored: ${id}`);
      } else {
        console.log(`No-op: ${id} was not soft-deleted (idempotent restore).`);
      }
    });

  // ── docs: list (also the default action when `cfcf clio docs` is run) ─
  // Browse what's actually in Clio. Useful for "what did I ingest the
  // other day?" + dogfooding the iteration-loop's auto-ingest hooks.
  // (`docsCmd` is hoisted at the top of registerUnder.)
  async function listDocs(opts: {
    project?: string;
    limit?: number;
    offset?: number;
    includeDeleted?: boolean;
    deletedOnly?: boolean;
    json?: boolean;
  }) {
    if (!(await checkServer())) return;
    if (opts.includeDeleted && opts.deletedOnly) {
      console.error("Note: --deleted-only and --include-deleted both passed; --deleted-only wins.");
    }
    const qs = new URLSearchParams();
    if (opts.project) qs.set("project", opts.project);
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.offset) qs.set("offset", String(opts.offset));
    if (opts.deletedOnly) qs.set("deleted_only", "true");
    else if (opts.includeDeleted) qs.set("include_deleted", "true");
    const url = qs.toString() ? `/api/clio/documents?${qs.toString()}` : "/api/clio/documents";
    const res = await get<{ documents: ClioDocument[] }>(url);
    if (!res.ok) {
      console.error(`docs list failed: ${res.error}`);
      process.exit(1);
    }
    const docs = res.data!.documents;
    if (opts.json) {
      console.log(JSON.stringify(docs, null, 2));
      return;
    }
    if (docs.length === 0) {
      console.log("No documents." + (opts.project ? ` (project: ${opts.project})` : ""));
      return;
    }
    const headerSuffix = opts.deletedOnly ? " (deleted only)"
      : opts.includeDeleted ? " (live + deleted)"
      : "";
    console.log(`${docs.length} document(s)${opts.project ? ` in project '${opts.project}'` : ""}${headerSuffix}:`);
    console.log();
    for (const d of docs) {
      const role = (d.metadata?.role as string | undefined) ?? "-";
      const type = (d.metadata?.artifact_type as string | undefined) ?? "-";
      const wsId = (d.metadata?.workspace_id as string | undefined) ?? "-";
      // Title + the agent-friendly [id: <uuid>] line so callers can
      // copy-paste the doc id into `cfcf clio docs ingest --document-id
      // <uuid>` without a follow-up lookup. Same convention as
      // `cfcf clio search`. `[DELETED]` prefix when soft-deleted so
      // mixed lists (--include-deleted) are scannable.
      const titlePrefix = d.deletedAt ? "[DELETED] " : "";
      const versionsHint = d.versionCount && d.versionCount > 0
        ? `  versions=${d.versionCount}`
        : "";
      const projectLabel = d.projectName
        ? `${d.projectName} [${d.projectId}]`
        : d.projectId;
      console.log(`  ${titlePrefix}${d.title}`);
      console.log(`    [id: ${d.id}]  author: ${d.author}${versionsHint}`);
      console.log(`    project: ${projectLabel}  chunks=${d.chunkCount}  chars=${d.totalChars}`);
      console.log(`    role=${role}  type=${type}  workspace=${wsId}`);
      console.log(`    source=${d.source}`);
      console.log(`    created=${d.createdAt}`);
      if (d.deletedAt) {
        console.log(`    deleted_at=${d.deletedAt}  (restore with: cfcf clio docs restore ${d.id})`);
      }
      console.log();
    }
    console.log(`Tip: --include-deleted to surface tombstones; --deleted-only for the trash-bin view; --json for raw records.`);
  }

  // Default action (no subcommand) = list. Mirrors `projects` defaulting to list.
  docsCmd
    .option("-p, --project <name>", "Scope to a single Clio Project (name or id)")
    .option("-n, --limit <n>", "Max docs to return (default 50, max 500)", (v) => parseInt(v, 10))
    .option("--offset <n>", "Pagination offset (default 0)", (v) => parseInt(v, 10))
    .option("--include-deleted", "Include soft-deleted docs alongside live ones")
    .option(
      "--deleted-only",
      "Show ONLY soft-deleted docs (trash-bin view). Mutually exclusive with --include-deleted; this flag wins.",
    )
    .option("--json", "Emit raw JSON")
    .action(listDocs);

  // Explicit `list` subcommand too, in case users type it out.
  docsCmd
    .command("list")
    .description("List Clio documents (newest first). Soft-deleted docs are excluded by default.")
    .option("-p, --project <name>", "Scope to a single Clio Project (name or id)")
    .option("-n, --limit <n>", "Max docs to return (default 50, max 500)", (v) => parseInt(v, 10))
    .option("--offset <n>", "Pagination offset (default 0)", (v) => parseInt(v, 10))
    .option("--include-deleted", "Include soft-deleted docs alongside live ones")
    .option(
      "--deleted-only",
      "Show ONLY soft-deleted docs (trash-bin view). Mutually exclusive with --include-deleted; this flag wins.",
    )
    .option("--json", "Emit raw JSON")
    .action(listDocs);

  // ── docs: edit ────────────────────────────────────────────────────────
  // Metadata-only edit. Updates any combination of title / author /
  // project / metadata WITHOUT re-ingesting content. No version snapshot
  // is taken (versions exist to protect content; metadata edits don't
  // touch chunks). Audit-log carries the before/after diff. 5.13 follow-up.
  docsCmd
    .command("edit <id>")
    .description("Edit a Clio document's metadata (title / author / project / metadata). Content is NOT touched.")
    .option("--title <title>", "Rename the document.")
    .option("--author <author>", "Set the document's author. Pass an empty string to clear (resets to 'agent').")
    .option("--project <name>", "Move the document to this Clio Project (by name or UUID).")
    .option(
      "--set-meta <kv>",
      "Add/overwrite a metadata key. Format: key=value (string|number|true|false|null). Repeatable.",
      (val: string, prev: string[] = []) => [...prev, val],
      [] as string[],
    )
    .option(
      "--unset-meta <key>",
      "Remove a metadata key. Repeatable.",
      (val: string, prev: string[] = []) => [...prev, val],
      [] as string[],
    )
    .option("--actor <actor>", "Audit-log attribution (who's making this edit). Defaults to 'agent'.")
    .option("--json", "Emit raw JSON")
    .action(async (id: string, opts: {
      title?: string;
      author?: string;
      project?: string;
      setMeta?: string[];
      unsetMeta?: string[];
      actor?: string;
      json?: boolean;
    }) => {
      if (!(await checkServer())) return;

      // Parse --set-meta key=value pairs. Tolerate quoted values; coerce
      // bare true/false/null/numbers to typed JSON. Strings stay strings.
      const metadataSet: Record<string, unknown> = {};
      for (const raw of opts.setMeta ?? []) {
        const eq = raw.indexOf("=");
        if (eq < 0) {
          console.error(`Invalid --set-meta '${raw}': expected key=value.`);
          process.exit(1);
        }
        const key = raw.slice(0, eq).trim();
        const valStr = raw.slice(eq + 1);
        if (!key) {
          console.error(`Invalid --set-meta '${raw}': empty key.`);
          process.exit(1);
        }
        let parsed: unknown = valStr;
        if (valStr === "true") parsed = true;
        else if (valStr === "false") parsed = false;
        else if (valStr === "null") parsed = null;
        else if (/^-?\d+(\.\d+)?$/.test(valStr)) parsed = Number(valStr);
        metadataSet[key] = parsed;
      }

      const payload: Record<string, unknown> = {};
      if (opts.title !== undefined) payload.title = opts.title;
      if (opts.author !== undefined) payload.author = opts.author;
      if (opts.project !== undefined) payload.projectName = opts.project;
      if (Object.keys(metadataSet).length > 0) payload.metadataSet = metadataSet;
      if (opts.unsetMeta && opts.unsetMeta.length > 0) payload.metadataUnset = opts.unsetMeta;
      if (opts.actor) payload.actor = opts.actor;

      if (Object.keys(payload).length === 0
          || (Object.keys(payload).length === 1 && payload.actor !== undefined)) {
        console.error("Nothing to edit. Pass at least one of --title, --author, --project, --set-meta, --unset-meta.");
        process.exit(1);
      }

      const res = await patch<{ updated: boolean; document: ClioDocument }>(
        `/api/clio/documents/${id}`,
        payload,
      );
      if (!res.ok) {
        console.error(`docs edit failed: ${res.error}`);
        process.exit(1);
      }
      const { updated, document } = res.data!;
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      if (!updated) {
        console.log(`No changes: every requested edit already matched the current state.`);
        return;
      }
      console.log(`Updated document ${document.id}`);
      console.log(`  title:   ${document.title}`);
      console.log(`  author:  ${document.author}`);
      console.log(`  project: ${document.projectId}`);
      console.log(`  metadata: ${JSON.stringify(document.metadata)}`);
      console.log();
      console.log(`Audit log: cfcf clio audit --document-id ${document.id}`);
    });

  // ── projects: list (default) / create / show ─────────────────────────
  // Plural-only namespace (Cerefox-parity rename: `project` was dropped
  // 2026-04-27 in the CLI verb normalisation pass — see decisions-log).
  // Listing is the default action when no subcommand is given.
  // (`projectsCmd` is hoisted at the top of registerUnder.)

  async function listProjects(opts: { json?: boolean }) {
    if (!(await checkServer())) return;
    const res = await get<ClioProjectListResponse>("/api/clio/projects");
    if (!res.ok) {
      console.error(`Failed to list Clio Projects: ${res.error}`);
      process.exit(1);
    }
    const projects = res.data!.projects;
    if (opts.json) {
      console.log(JSON.stringify(projects, null, 2));
      return;
    }
    if (projects.length === 0) {
      console.log("No Clio Projects. Create one with: cfcf clio project create <name>");
      return;
    }
    console.log(`${projects.length} Clio Project(s):`);
    for (const p of projects) {
      const desc = p.description ? ` — ${p.description}` : "";
      const count = p.documentCount != null ? ` (${p.documentCount} doc${p.documentCount === 1 ? "" : "s"})` : "";
      console.log(`  ${p.name}${count}${desc}`);
      console.log(`    id: ${p.id}`);
    }
  }

  // Default action (no subcommand) = list.
  projectsCmd
    .option("--json", "Print the raw list as JSON (only used when no subcommand is given)")
    .action(async (opts) => {
      await listProjects(opts);
    });

  // Explicit `list` subcommand too, in case users type it out.
  projectsCmd
    .command("list")
    .description("List all Clio Projects (same as `cfcf clio project` with no subcommand)")
    .option("--json", "Print the raw list as JSON")
    .action(async (opts) => {
      await listProjects(opts);
    });

  projectsCmd
    .command("create <name>")
    .description("Create a new Clio Project")
    .option("-d, --description <text>", "Optional description shown in `cfcf clio project`")
    .action(async (name: string, opts) => {
      if (!(await checkServer())) return;
      const res = await post<ClioProject>("/api/clio/projects", { name, description: opts.description });
      if (!res.ok) {
        console.error(`Failed to create Clio Project: ${res.error}`);
        process.exit(1);
      }
      const p = res.data!;
      console.log(`Created Clio Project: ${p.name} (${p.id})`);
    });

  projectsCmd
    .command("show <nameOrId>")
    .description("Show a Clio Project's metadata")
    .action(async (nameOrId: string) => {
      if (!(await checkServer())) return;
      const res = await get<ClioProject>(`/api/clio/projects/${encodeURIComponent(nameOrId)}`);
      if (!res.ok) {
        console.error(`Not found: ${nameOrId}`);
        process.exit(1);
      }
      const p = res.data!;
      console.log(`Clio Project: ${p.name}`);
      console.log(`  id:           ${p.id}`);
      console.log(`  description:  ${p.description ?? "(none)"}`);
      console.log(`  created_at:   ${p.createdAt}`);
      console.log(`  updated_at:   ${p.updatedAt}`);
      if (p.documentCount != null) console.log(`  documents:    ${p.documentCount}`);
    });

  // ── embedder ──────────────────────────────────────────────────────────
  // (`embedderCmd` is hoisted at the top of registerUnder.)
  embedderCmd
    .command("list")
    .description("List supported embedders from the catalogue, marking the active one.")
    .option("--json", "Emit JSON")
    .action(async (opts) => {
      if (!(await checkServer())) return;
      const res = await get<{ catalogue: Array<{ name: string; dim: number; approxSizeMb: number; description: string; recommendedChunkMaxChars: number; recommendedExpansionRadius: number; active: boolean }> }>("/api/clio/embedders");
      if (!res.ok) {
        console.error(`Failed to list embedders: ${res.error}`);
        process.exit(1);
      }
      const list = res.data!.catalogue;
      if (opts.json) {
        console.log(JSON.stringify(list, null, 2));
        return;
      }
      for (const e of list) {
        const marker = e.active ? "●" : " ";
        console.log(` ${marker} ${e.name.padEnd(28)}  dim=${String(e.dim).padStart(4)}  ~${String(e.approxSizeMb).padStart(4)} MB  chunk=${String(e.recommendedChunkMaxChars).padStart(5)}  expand=±${e.recommendedExpansionRadius}`);
        console.log(`    ${e.description}`);
      }
      console.log();
      console.log("● = currently active.");
      console.log();
      console.log("Install + activate:  cfcf clio embedder install [name]  (name optional if set during `cfcf init`)");
      console.log("Switch active:       cfcf clio embedder set <name>");
    });

  embedderCmd
    .command("active")
    .description("Show the currently-active embedder (or \"none\" if none is installed).")
    .option("--json", "Emit JSON")
    .action(async (opts) => {
      if (!(await checkServer())) return;
      const res = await get<ClioStats>("/api/clio/stats");
      if (!res.ok) {
        console.error(`Failed to fetch Clio stats: ${res.error}`);
        process.exit(1);
      }
      const active = res.data!.activeEmbedder;
      if (opts.json) {
        console.log(JSON.stringify(active, null, 2));
        return;
      }
      if (!active) {
        console.log("No active embedder. Install one:");
        console.log(`  cfcf clio embedder install ${DEFAULT_EMBEDDER_NAME}`);
        console.log("Until then, Clio runs in FTS-only keyword-search mode.");
      } else {
        console.log(`Active: ${active.name} (dim=${active.dim}, chunk=${active.recommendedChunkMaxChars} chars)`);
      }
    });

  embedderCmd
    .command("install [name]")
    .description(
      "Install + activate an embedder. First call downloads the model files via " +
      "HuggingFace (~20-430 MB depending on model; subsequent runs read from " +
      "~/.cfcf/models/).\n\n" +
      "If <name> is omitted, uses the embedder you picked during `cfcf init` " +
      "(saved as clio.preferredEmbedder in the global config). Falls back to " +
      `the catalogue default (${DEFAULT_EMBEDDER_NAME}) when no preference has been ` +
      "set. Useful for retrying a failed init download or installing from a " +
      "script that read the config itself.",
    )
    .option("--force", "Install even if chunks with the old embedder exist. Poisons the vector corpus -- use `cfcf clio embedder set --reindex` instead for a safe switch.")
    .action(async (name: string | undefined, opts) => {
      if (!(await checkServer())) return;

      // Resolve the embedder name: explicit arg > config preference >
      // catalogue default. The CLI fetches the global config from the
      // server so there's exactly one source of truth.
      let resolvedName = name;
      if (!resolvedName) {
        const cfgRes = await get<{ clio?: { preferredEmbedder?: string } }>("/api/config");
        if (cfgRes.ok && cfgRes.data?.clio?.preferredEmbedder) {
          resolvedName = cfgRes.data.clio.preferredEmbedder;
          console.log(`Using preferred embedder from config: ${resolvedName}`);
        } else {
          resolvedName = DEFAULT_EMBEDDER_NAME;
          console.log(`No preferred embedder set; defaulting to ${resolvedName}.`);
        }
      }

      const res = await post<{ active: { name: string; dim: number; recommendedChunkMaxChars: number }; downloaded: boolean }>(
        "/api/clio/embedders/install",
        { name: resolvedName, force: !!opts.force },
      );
      if (!res.ok) {
        console.error(`Install failed: ${res.error}`);
        process.exit(1);
      }
      const a = res.data!.active;
      console.log(`Active embedder: ${a.name} (dim=${a.dim}, chunk=${a.recommendedChunkMaxChars} chars)`);
      console.log(res.data!.downloaded ? "Model downloaded + cached to ~/.cfcf/models/." : "Model already cached -- no download needed.");
    });

  embedderCmd
    .command("set <name>")
    .description(
      "Switch the active embedder.\n" +
      "\n" +
      "Default: refuses when existing chunks have embeddings from a different\n" +
      "model -- a naive switch would leave those chunks invisible to vector\n" +
      "search since their embeddings are in the old model's space.\n" +
      "\n" +
      "With --reindex: switches + re-embeds every existing chunk under the\n" +
      "new model in one atomic pass. Safe, supported, recommended.\n" +
      "\n" +
      "With --force: switches without reindex. Vector search will be\n" +
      "effectively broken for pre-switch chunks until you run\n" +
      "`cfcf clio reindex`. Reserved for recovery scenarios.",
    )
    .option("--reindex", "Switch + re-embed every existing chunk under the new model. Preferred over --force.")
    .option("--force", "Switch without reindex. Only for recovery; vector search is degraded until you run `cfcf clio reindex`.")
    .option("-y, --yes", "Skip the impact-summary confirmation prompt (non-interactive use).")
    .action(async (name: string, opts) => {
      if (!(await checkServer())) return;
      if (opts.force && opts.reindex) {
        console.error("Pass either --reindex or --force, not both. --reindex is the safe path.");
        process.exit(1);
      }

      // Pre-flight: pull the impact summary so we can warn the user
      // before the switch. Three classes of issue:
      //   1. Existing chunks have embeddings from a different model →
      //      they go stale unless --reindex is also passed.
      //   2. Existing chunk char_counts exceed the new embedder's
      //      recommended max → silent truncation at embed time.
      //   3. Configured `clio.maxChunkChars` exceeds the new ceiling →
      //      future ingests get capped, not honoured verbatim.
      const impactRes = await get<{
        newName: string;
        newRecommendedChunkMaxChars: number;
        currentName: string | null;
        currentRecommendedChunkMaxChars: number | null;
        totalChunkCount: number;
        embeddedChunkCount: number;
        chunksOverNewCeiling: number;
        configMaxChunkChars: number | null;
        configMaxOverCeiling: boolean;
        error?: string;
      }>(`/api/clio/embedders/${encodeURIComponent(name)}/switch-impact`);
      if (!impactRes.ok) {
        console.error(`Set failed (preview): ${impactRes.error}`);
        process.exit(1);
      }
      const impact = impactRes.data!;
      const warnings: string[] = [];
      if (impact.embeddedChunkCount > 0 && !opts.reindex && impact.currentName !== name) {
        warnings.push(
          `${impact.embeddedChunkCount} chunk(s) carry embeddings from "${impact.currentName ?? "(none)"}". ` +
          `Without --reindex they become inconsistent with "${name}"'s embedding space. ` +
          `Vector search quality on those chunks will degrade. Recommended: re-run with --reindex.`,
        );
      }
      if (impact.chunksOverNewCeiling > 0) {
        warnings.push(
          `${impact.chunksOverNewCeiling} existing chunk(s) exceed "${name}"'s recommended max ` +
          `(${impact.newRecommendedChunkMaxChars} chars). The model will silently truncate those inputs ` +
          `at embed time, degrading quality. Re-chunking is tracked under plan item 6.23.`,
        );
      }
      if (impact.configMaxOverCeiling) {
        warnings.push(
          `Your config's clio.maxChunkChars (${impact.configMaxChunkChars}) exceeds "${name}"'s ceiling ` +
          `(${impact.newRecommendedChunkMaxChars}). Future ingests will be capped to ${impact.newRecommendedChunkMaxChars}; ` +
          `the config value won't be honoured verbatim.`,
        );
      }
      if (warnings.length > 0 && !opts.yes && !opts.force) {
        console.log(`Switching active embedder: ${impact.currentName ?? "(none)"} → ${name}`);
        console.log();
        for (const w of warnings) console.log(`  ⚠ ${w}`);
        console.log();
        if (!process.stdin.isTTY) {
          console.error(
            "Refusing to proceed: stdin is not a TTY and -y/--yes was not passed. " +
            "Pass --yes (acknowledge warnings + proceed), --reindex (proceed + re-embed), " +
            "or --force (recovery; switch without reindex).",
          );
          process.exit(1);
        }
        const proceed = await promptYesNo("Proceed with the switch?");
        if (!proceed) {
          console.log("Aborted. No changes were made.");
          return;
        }
      }

      // The --reindex path runs the server-side embedder loop over
      // every chunk and can take several seconds. Spinner only when
      // --reindex is set; the bare set is just a DB row update.
      const stopSpinner = startSpinner({
        label: `switching embedder to ${name}${opts.reindex ? " + reindexing" : ""}`,
        enable: !!opts.reindex && !!process.stderr.isTTY,
      });
      const res = await post<{ active: { name: string; dim: number }; reindex?: { chunksReembedded: number; chunksSkipped: number; documentsTouched: number; elapsedMs: number } | null }>(
        "/api/clio/embedders/set",
        { name, force: !!opts.force, reindex: !!opts.reindex },
      );
      stopSpinner();
      if (!res.ok) {
        console.error(`Set failed: ${res.error}`);
        process.exit(1);
      }
      console.log(`Active embedder: ${res.data!.active.name} (dim=${res.data!.active.dim})`);
      if (res.data!.reindex) {
        const r = res.data!.reindex;
        console.log(`Reindex: re-embedded ${r.chunksReembedded} chunk(s) across ${r.documentsTouched} document(s) in ${r.elapsedMs}ms.`);
      } else if (opts.force) {
        console.log("WARNING: --force used without --reindex. Vector search will be degraded for pre-switch chunks until you run `cfcf clio reindex`.");
      }
    });

  root
    .command("reindex")
    .description(
      "Re-embed chunks under the currently-active embedder. Idempotent: chunks already matching the active embedder+dim are skipped. Pair with `cfcf clio embedder set --reindex` for the canonical embedder-switch flow.",
    )
    .option("-p, --project <name>", "Restrict to one Clio Project")
    .option("--force", "Re-embed every chunk even if it already matches the active embedder")
    .option("--batch-size <n>", "Embedder batch size (default 32)", (v) => parseInt(v, 10))
    .option("-y, --yes", "Skip the confirmation prompt (non-interactive use).")
    .option("--json", "Emit the raw JSON result")
    .action(async (opts) => {
      if (!(await checkServer())) return;
      // Pre-flight confirmation: reindex re-embeds many chunks under
      // the active embedder; for a non-trivial corpus that's many
      // seconds of compute + writes. Show the active embedder + the
      // active project scope before we run, prompt unless --yes/--force.
      if (!opts.yes && !opts.force && !opts.json) {
        const activeRes = await get<{ active: { name: string; dim: number } | null }>(
          "/api/clio/embedders/active",
        );
        const activeName = activeRes.ok && activeRes.data?.active
          ? activeRes.data.active.name
          : "(no active embedder)";
        console.log(`Reindex will re-embed chunks under: ${activeName}`);
        if (opts.project) console.log(`Scope: project "${opts.project}"`);
        else console.log(`Scope: ALL projects (pass --project to narrow)`);
        console.log("Idempotent: chunks already matching the active embedder + dim are skipped.");
        console.log("Cost: a few seconds per ~30 chunks (model-dependent).");
        if (!process.stdin.isTTY) {
          console.error(
            "Refusing to proceed: stdin is not a TTY and -y/--yes was not passed. " +
            "Pass --yes to accept the impact summary above.",
          );
          process.exit(1);
        }
        const proceed = await promptYesNo("Proceed?");
        if (!proceed) {
          console.log("Aborted. No changes were made.");
          return;
        }
      }
      // Reindex is the slowest cfcf command -- the server runs
      // embedder.embed() in batches over every chunk in scope. For a
      // non-trivial corpus this is many seconds; spinner provides
      // motion. Suppressed in --json + non-TTY for clean machine output.
      const stopSpinner = startSpinner({
        label: `reindexing chunks${opts.project ? ` (project: ${opts.project})` : ""}${opts.force ? " [force]" : ""}`,
        enable: !opts.json && !!process.stderr.isTTY,
      });
      const res = await post<{ embedder: string; embeddingDim: number; chunksScanned: number; chunksReembedded: number; chunksSkipped: number; documentsTouched: number; elapsedMs: number }>(
        "/api/clio/reindex",
        {
          project: opts.project,
          force: !!opts.force,
          batchSize: opts.batchSize,
        },
      );
      stopSpinner();
      if (!res.ok) {
        console.error(`Reindex failed: ${res.error}`);
        process.exit(1);
      }
      const r = res.data!;
      if (opts.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      console.log(`Reindex complete:`);
      console.log(`  embedder:        ${r.embedder} (dim=${r.embeddingDim})`);
      console.log(`  chunks scanned:  ${r.chunksScanned}`);
      console.log(`  re-embedded:     ${r.chunksReembedded}`);
      console.log(`  skipped:         ${r.chunksSkipped} (already matching)`);
      console.log(`  docs touched:    ${r.documentsTouched}`);
      console.log(`  elapsed:         ${r.elapsedMs}ms`);
    });

  // ── stats ─────────────────────────────────────────────────────────────
  root
    .command("stats")
    .description("DB size, counts, applied migrations, active embedder")
    .option("--json", "Print the raw JSON response")
    .action(async (opts) => {
      if (!(await checkServer())) return;
      const res = await get<ClioStats>("/api/clio/stats");
      if (!res.ok) {
        console.error(`Failed to fetch Clio stats: ${res.error}`);
        process.exit(1);
      }
      const s = res.data!;
      if (opts.json) {
        console.log(JSON.stringify(s, null, 2));
        return;
      }
      console.log(`Clio stats`);
      console.log(`  db:              ${s.dbPath}`);
      console.log(`  size:            ${formatBytes(s.dbSizeBytes)}`);
      console.log(`  projects:        ${s.projectCount}`);
      console.log(`  documents:       ${s.documentCount}`);
      console.log(`  chunks:          ${s.chunkCount}`);
      console.log(`  active embedder: ${s.activeEmbedder ? s.activeEmbedder.name : `(none — install one: cfcf clio embedder install ${DEFAULT_EMBEDDER_NAME})`}`);
      console.log(`  migrations:`);
      for (const m of s.migrations) console.log(`    ${m}`);
    });
}

// ── helpers ─────────────────────────────────────────────────────────────

async function checkServer(): Promise<boolean> {
  if (await isServerReachable()) return true;
  console.error("cfcf server is not running. Start it with: cfcf server start");
  process.exit(1);
}

function printHit(rank: number, h: SearchHit): void {
  const heading = h.headingPath.length > 0 ? ` > ${h.headingPath.join(" > ")}` : "";
  // Title + score line. Followed by [id: <full-uuid>] in copy-pasteable
  // form (5.12) so agents can: search → grep [id: → feed back into
  // `cfcf clio docs ingest --document-id <uuid>` for updates. The chunk id
  // is also shown but truncated since it isn't the agent's primary key.
  console.log(`  ${rank}. [${h.score.toFixed(3)}] ${h.docTitle}${heading}`);
  console.log(`     [id: ${h.documentId}]  author: ${h.docAuthor}`);
  console.log(`     ${h.docSource}  (chunk ${h.chunkIndex}, chunk_id=${h.chunkId.slice(0, 8)}…)`);
  const snippet = h.content.trim().split("\n").slice(0, 3).join(" ").slice(0, 160);
  console.log(`     ${snippet}${h.content.length > 160 ? "…" : ""}`);
  console.log();
}

/**
 * Render one document-level search hit. Doc-level is the default
 * `cfcf clio search` view; `--by-chunk` falls back to `printHit` above.
 *
 * Layout decisions:
 *   - Top line: rank, best score, doc title, best-chunk heading path.
 *   - id line: copy-pasteable [id: <uuid>] for the agent workflow,
 *     plus author + versions count + matching-chunks count.
 *   - source line: where the doc came from + best-chunk index for
 *     debugging.
 *   - snippet: first ~160 chars of the best chunk's small-to-big-
 *     expanded content.
 */
function printDocHit(rank: number, h: DocumentSearchHit): void {
  const heading = h.bestChunkHeadingPath.length > 0
    ? ` > ${h.bestChunkHeadingPath.join(" > ")}`
    : "";
  const versionsStr = h.versionCount > 0 ? `  versions=${h.versionCount}` : "";
  const matchesStr = h.matchingChunks > 1 ? `  matched ${h.matchingChunks} chunks` : "";
  // Cerefox-style: small docs return FULL content (is_partial=false);
  // large docs return chunk + neighbours (is_partial=true). Surface
  // this so users / agents know whether to call `cfcf clio get` for
  // the rest.
  const partialHint = h.isPartial
    ? `  (chunk + window of ${h.chunkCount} total)`
    : `  (full doc, ${h.totalChars} chars)`;
  console.log(`  ${rank}. [${h.bestScore.toFixed(3)}] ${h.docTitle}${heading}`);
  console.log(`     [id: ${h.documentId}]  author: ${h.docAuthor}${versionsStr}${matchesStr}`);
  console.log(`     project: ${h.docProjectName}  source: ${h.docSource}${partialHint}`);
  const snippet = h.bestChunkContent.trim().split("\n").slice(0, 3).join(" ").slice(0, 160);
  console.log(`     ${snippet}${h.bestChunkContent.length > 160 ? "…" : ""}`);
  console.log();
}

/**
 * Render a stderr spinner with elapsed time while a slow CLI command's
 * HTTP request is in flight. Returns a stop function that clears the
 * spinner line in-place so the final result starts on a clean row.
 *
 * Why: commands like `cfcf clio ingest` and `cfcf clio reindex` block
 * on a fetch() that takes several seconds (the server runs
 * `embedder.embed()` over every chunk synchronously). Without a
 * spinner the UX feels stuck. Same `\r\x1b[K` in-place rewrite
 * convention as the embedder-download progress bar in
 * `OnnxEmbedder.progress_callback`.
 *
 * Disabled when `enable=false` (--json output, non-TTY stderr) -- the
 * spinner produces no lines in the log, callers see only the final
 * result. Cheap: braille-pattern frame every 100ms.
 */
function startSpinner(opts: { label: string; enable: boolean }): () => void {
  if (!opts.enable) return () => { /* no-op */ };
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const start = Date.now();
  let frame = 0;
  const render = () => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    process.stderr.write(
      `\r\x1b[K[clio] ${frames[frame % frames.length]} ${opts.label}  ${elapsed}s`,
    );
    frame++;
  };
  render();
  const handle = setInterval(render, 100);
  return () => {
    clearInterval(handle);
    process.stderr.write("\r\x1b[K");
  };
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "(empty)";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 2 : value < 100 ? 1 : 0)} ${units[i]}`;
}

/**
 * Tiny y/N prompt using `node:readline`. Returns true on `y` / `yes`;
 * any other answer (including empty) is treated as no. Caller is
 * responsible for ensuring stdin is a TTY before calling -- this just
 * does the readline dance.
 */
async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
  }
  return chunks.join("");
}
