/**
 * `cfcf clio <verb>` -- Clio memory layer CLI (item 5.7 PR1).
 *
 * Verbs: search | ingest | get | projects | project | stats. `cfcf memory`
 * is registered as a top-level alias that points at the same command tree.
 */

import type { Command } from "commander";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { isServerReachable, post, get } from "../client.js";
import type {
  ClioProject,
  ClioDocument,
  IngestResult,
  SearchResponse,
  SearchHit,
  ClioStats,
} from "@cfcf/core";

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
  // ── search ────────────────────────────────────────────────────────────
  root
    .command("search <query...>")
    .description("Search Clio for documents matching <query> (FTS keyword search in v1)")
    .option("-p, --project <name>", "Scope to a single Clio Project (name or id)")
    .option("-n, --match-count <n>", "Max number of hits to return (default 10)", (v) => parseInt(v, 10))
    .option(
      "-m, --metadata <json>",
      "Exact-match metadata filter, e.g. '{\"role\":\"reflection\",\"artifact_type\":\"reflection-analysis\"}'",
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

      console.log(`${data.hits.length} hit(s) for "${q}" (${data.mode}):`);
      console.log();
      data.hits.forEach((h, i) => printHit(i + 1, h));
    });

  // ── ingest ────────────────────────────────────────────────────────────
  root
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

      const title = opts.title || defaultTitle;
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

      const res = await post<IngestResult>("/api/clio/ingest", {
        project: opts.project,
        title,
        content,
        source,
        metadata,
      });
      if (!res.ok) {
        console.error(`Ingest failed: ${res.error}`);
        process.exit(1);
      }
      const data = res.data!;

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      if (data.created) {
        console.log(`Ingested: ${data.document.title} (${data.chunksInserted} chunk${data.chunksInserted === 1 ? "" : "s"})`);
        console.log(`  id:      ${data.id}`);
        console.log(`  project: ${data.document.projectId}`);
        console.log(`  source:  ${data.document.source}`);
      } else {
        console.log(`Already in Clio (content_hash match): ${data.document.title}`);
        console.log(`  id:      ${data.id}`);
      }
    });

  // ── get ───────────────────────────────────────────────────────────────
  root
    .command("get <id>")
    .description("Retrieve a Clio document by id")
    .option("--raw", "Print only the raw concatenated chunk content")
    .option("--json", "Print the full document record as JSON")
    .action(async (id: string, opts) => {
      if (!(await checkServer())) return;
      const res = await get<ClioDocument>(`/api/clio/documents/${encodeURIComponent(id)}`);
      if (!res.ok) {
        console.error(`Not found: ${id}`);
        process.exit(1);
      }
      const doc = res.data!;
      if (opts.json) {
        console.log(JSON.stringify(doc, null, 2));
        return;
      }
      console.log(`# ${doc.title}`);
      console.log();
      console.log(`  id:            ${doc.id}`);
      console.log(`  project:       ${doc.projectId}`);
      console.log(`  source:        ${doc.source}`);
      console.log(`  content_hash:  ${doc.contentHash}`);
      console.log(`  review_status: ${doc.reviewStatus}`);
      console.log(`  chunks:        ${doc.chunkCount}`);
      console.log(`  total_chars:   ${doc.totalChars}`);
      console.log(`  created_at:    ${doc.createdAt}`);
      if (doc.metadata && Object.keys(doc.metadata).length > 0) {
        console.log(`  metadata:`);
        for (const [k, v] of Object.entries(doc.metadata)) {
          console.log(`    ${k}: ${JSON.stringify(v)}`);
        }
      }
      if (opts.raw) {
        console.log();
        console.log("--- content ---");
        console.log("(Pass --json for the full document record. v1 doesn't reconstruct full content from chunks in CLI output yet; use GET /api/clio/documents/:id programmatically for now.)");
      }
    });

  // ── projects ──────────────────────────────────────────────────────────
  root
    .command("projects")
    .description("List all Clio Projects")
    .option("--json", "Print the raw list as JSON")
    .action(async (opts) => {
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
    });

  // ── project (create | show) ───────────────────────────────────────────
  const projectCmd = root.command("project").description("Create / inspect Clio Projects");

  projectCmd
    .command("create <name>")
    .description("Create a new Clio Project")
    .option("-d, --description <text>", "Optional description shown in `cfcf clio projects`")
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

  projectCmd
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
      console.log(`  active embedder: ${s.activeEmbedder ? s.activeEmbedder.name : "(none — PR2 will bundle bge-small-en-v1.5)"}`);
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
  console.log(`  ${rank}. [${h.score.toFixed(3)}] ${h.docTitle}${heading}`);
  console.log(`     ${h.docSource}  (chunk ${h.chunkIndex}, id=${h.chunkId.slice(0, 8)}…)`);
  const snippet = h.content.trim().split("\n").slice(0, 3).join(" ").slice(0, 160);
  console.log(`     ${snippet}${h.content.length > 160 ? "…" : ""}`);
  console.log();
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

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
  }
  return chunks.join("");
}
