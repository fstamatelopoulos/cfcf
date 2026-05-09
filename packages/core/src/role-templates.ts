/**
 * Role-template management (item 6.8) — versioning + promote-to-production
 * layer on top of the existing `getTemplate()` override mechanism in
 * `templates.ts`.
 *
 * **Design** (full doc: `docs/design/role-template-management.md`):
 *
 * Two version types (item 6.8 round 2):
 *
 *   1. **`type: "full"`** — the user's body REPLACES the bundled default
 *      entirely. Maximum flexibility (delete sections, restructure,
 *      anything). Caveat: when cf² ships a new bundled default, the user
 *      doesn't pick it up automatically — their version is frozen until
 *      they manually re-fork. Surfaced in the UI as a "forked from cf²
 *      vX.Y.Z" badge so the user knows their version may be drifting.
 *
 *   2. **`type: "augmented"`** — the user's body is APPENDED to the
 *      bundled default with a separator. The bundled default is always
 *      read live (never duplicated on disk), so when cf² upgrades the
 *      default, the user's extension automatically rides along on the
 *      new version — no migration. The harness recomposes
 *      `<bundled-default> + <separator> + <extension>` at promote time
 *      AND at every server boot (cheap, idempotent — only writes if the
 *      composed content actually differs from what's on disk). Less
 *      flexibility than full (you can't delete sections from the
 *      default), but upgrade-friendly by default.
 *
 * - The bundled default for each role is read from the EMBEDDED registry
 *   in `templates.ts` (already shipped). Read-only, never deletable.
 * - User-saved versions live under `~/.cfcf/templates-managed/<name>/`:
 *
 *   ```
 *   ~/.cfcf/templates-managed/cfcf-judge-instructions.md/
 *     manifest.json   {
 *                       currentVersionId,
 *                       versions: [{ id, label, savedAt, contentHash, type, cfcfVersion }]
 *                     }
 *     v_<id>.md       content body — full template body for type="full",
 *                     extension only for type="augmented"
 *   ```
 *
 * - When the user **promotes a version to production**, the manager
 *   writes a content file to `~/.cfcf/templates/<name>` (the existing
 *   override path that `getTemplate()` already reads). No runtime change
 *   to the agent-spawn pipeline. For `type="augmented"`, the manager
 *   composes `<bundled-default> + <separator> + <extension>` before
 *   writing.
 * - **Promoting "default"** deletes that override file so `getTemplate()`
 *   falls through to the bundled default.
 * - **Boot-time refresh** (`refreshAugmentedOverrides`) re-composes any
 *   promoted augmented version on every server boot, picking up cf²
 *   upgrades to the bundled default transparently.
 *
 * **Managed templates (MVP)**: the four iteration-role instruction
 * templates + the workspace process template. Dev's instructions are
 * generated programmatically by `context-assembler.generateInstructionContent()`
 * — a separate "custom directions" insertion-point design will follow.
 */

import { readFile, writeFile, mkdir, readdir, rm } from "fs/promises";
import { existsSync } from "node:fs";
import { join } from "path";
import { createHash, randomBytes } from "crypto";
import { getConfigDir, VERSION } from "./constants.js";
import { listTemplates, getEmbeddedTemplate } from "./templates.js";

// --- Composition constants ---

/**
 * Separator inserted between the bundled default and the user extension
 * when composing a promoted augmented version. The h2 heading is meant
 * to be unambiguous in the rendered template (any agent reading the
 * file will see it cleanly), and the parenthetical points editors at
 * the right surface.
 */
export const AUGMENTATION_SEPARATOR =
  "\n\n---\n\n## Custom additions\n\n*(Managed via the cf² Agents tab — edit this section there, not in this file.)*\n\n";

// --- Public types ---

export type TemplateVersionType = "full" | "augmented";

export interface TemplateVersion {
  id: string;
  label: string;
  savedAt: string;
  /** Short prefix of sha256(content). Display-only. */
  contentHash: string;
  /**
   * Version type (item 6.8 round 2).
   * - `"full"`: body replaces the bundled default entirely.
   * - `"augmented"`: body is appended to the bundled default at promote time.
   *
   * Defaults to `"full"` for back-compat with versions saved before
   * round 2 (manifests written by the round-1 code don't have this
   * field — we backfill on read).
   */
  type: TemplateVersionType;
  /**
   * The cf² version that was running when this version was saved.
   * Used by the UI's "forked from cf² vX.Y.Z" badge on full versions
   * so the user knows their version may have drifted from the current
   * bundled default. Augmented versions don't drift (they always
   * compose against the live default), so the badge is only shown for
   * `type="full"`. Optional for back-compat.
   */
  cfcfVersion?: string;
}

export interface ManagedTemplate {
  name: string;
  displayName: string;
  /** The bundled default content, read-only. */
  defaultContent: string;
  /** "default" or a saved version id. The version that's currently the override file. */
  currentVersionId: string;
  /** The content currently in effect (default or the promoted version). */
  currentContent: string;
  /** User-saved versions. Empty array when nothing has been saved yet. */
  versions: TemplateVersion[];
}

export interface ManagedTemplateSummary {
  name: string;
  displayName: string;
  currentVersionId: string;
  /** Number of user-saved versions (excludes default). */
  versionCount: number;
}

// --- Managed-template registry ---

/**
 * The set of templates exposed via the management UI. Order matters —
 * it's the tab order in the web UI. Only templates listed here can be
 * managed; everything else in `EMBEDDED` is internal scaffolding (signal
 * files, markdown stubs) that wouldn't make sense to expose.
 *
 * If you add a new role-instruction template to the embedded registry,
 * add it here too to surface it in the management UI.
 */
const MANAGED_TEMPLATES: Array<{ name: string; displayName: string }> = [
  { name: "cfcf-architect-instructions.md", displayName: "Solution Architect" },
  { name: "cfcf-judge-instructions.md", displayName: "Judge" },
  { name: "cfcf-documenter-instructions.md", displayName: "Documenter" },
  { name: "cfcf-reflection-instructions.md", displayName: "Reflection" },
  { name: "process.md", displayName: "Workspace Process" },
];

export function listManagedTemplateNames(): Array<{ name: string; displayName: string }> {
  return [...MANAGED_TEMPLATES];
}

// --- Storage paths ---

const DEFAULT_VERSION_ID = "default";
const VERSION_ID_PREFIX = "v_";

function templatesManagedRoot(): string {
  return join(getConfigDir(), "templates-managed");
}

function templateDir(name: string): string {
  return join(templatesManagedRoot(), name);
}

function manifestPath(name: string): string {
  return join(templateDir(name), "manifest.json");
}

function versionFilePath(name: string, versionId: string): string {
  return join(templateDir(name), `${versionId}.md`);
}

/** The override path read by `getTemplate()`. Promotion writes here. */
function overrideFilePath(name: string): string {
  return join(getConfigDir(), "templates", name);
}

// --- Manifest I/O ---

interface Manifest {
  currentVersionId: string;
  versions: TemplateVersion[];
}

function emptyManifest(): Manifest {
  // **Always return a fresh object + array** — earlier we kept a single
  // shared EMPTY_MANIFEST constant and shallow-copied via `{...}`,
  // which leaked the inner `versions: []` array between calls.
  // `manifest.versions.push(...)` in saveVersion was mutating the
  // shared array, so every subsequent fresh-manifest read started
  // with stale versions.
  return { currentVersionId: DEFAULT_VERSION_ID, versions: [] };
}

async function readManifest(name: string): Promise<Manifest> {
  try {
    const raw = await readFile(manifestPath(name), "utf-8");
    const parsed = JSON.parse(raw) as Manifest;
    // Defensive against partial / corrupt manifests.
    if (
      typeof parsed.currentVersionId !== "string" ||
      !Array.isArray(parsed.versions)
    ) {
      return emptyManifest();
    }
    // Back-compat: round 1 manifests don't have a `type` field on each
    // version. Fill it in as "full" since that was the only mode shipped.
    for (const v of parsed.versions) {
      if (!v.type) v.type = "full";
    }
    return parsed;
  } catch {
    return emptyManifest();
  }
}

async function writeManifest(name: string, manifest: Manifest): Promise<void> {
  await mkdir(templateDir(name), { recursive: true });
  await writeFile(manifestPath(name), JSON.stringify(manifest, null, 2), "utf-8");
}

// --- Validators ---

function assertManagedTemplate(name: string): void {
  if (!MANAGED_TEMPLATES.some((t) => t.name === name)) {
    throw new Error(
      `Template "${name}" is not managed. Managed templates: ${MANAGED_TEMPLATES.map((t) => t.name).join(", ")}`,
    );
  }
}

function assertEmbeddedTemplate(name: string): void {
  if (!listTemplates().includes(name)) {
    throw new Error(`Unknown template: ${name}`);
  }
}

function isVersionId(id: string): boolean {
  return id === DEFAULT_VERSION_ID || id.startsWith(VERSION_ID_PREFIX);
}

// --- Helpers ---

function generateVersionId(): string {
  return VERSION_ID_PREFIX + randomBytes(6).toString("hex");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

/**
 * Resolve the "default" content (bundled, read-only). Reads the
 * embedded constant directly so we never pick up an override.
 */
function readDefaultContent(name: string): string {
  return getEmbeddedTemplate(name);
}

/**
 * Read the saved version content from disk.
 *
 * - `versionId === "default"` → embedded default (read-only).
 * - any other id → `~/.cfcf/templates-managed/<name>/<id>.md`
 */
async function readVersionContent(name: string, versionId: string): Promise<string> {
  if (versionId === DEFAULT_VERSION_ID) {
    return readDefaultContent(name);
  }
  return readFile(versionFilePath(name, versionId), "utf-8");
}

// Note: `readDefaultContent` returns synchronously (it reads an
// already-bundled string constant), but `readVersionContent` is async
// because it touches disk. Callers `await` `readDefaultContent`
// without harm (await on a non-promise is a no-op).

// --- Public API ---

/**
 * List every managed template with summary info (no full content).
 * Used by the web UI's role-tab list.
 */
export async function listManagedTemplates(): Promise<ManagedTemplateSummary[]> {
  const out: ManagedTemplateSummary[] = [];
  for (const t of MANAGED_TEMPLATES) {
    const manifest = await readManifest(t.name);
    out.push({
      name: t.name,
      displayName: t.displayName,
      currentVersionId: manifest.currentVersionId,
      versionCount: manifest.versions.length,
    });
  }
  return out;
}

/**
 * Get the full management state for one role template.
 */
export async function getManagedTemplate(name: string): Promise<ManagedTemplate> {
  assertManagedTemplate(name);
  const meta = MANAGED_TEMPLATES.find((t) => t.name === name)!;
  const manifest = await readManifest(name);
  const defaultContent = readDefaultContent(name);
  const currentContent =
    manifest.currentVersionId === DEFAULT_VERSION_ID
      ? defaultContent
      : await readVersionContent(name, manifest.currentVersionId).catch(() => {
          // Promoted version's file is missing — manifest is stale.
          // Self-heal: fall back to default.
          return defaultContent;
        });
  return {
    name,
    displayName: meta.displayName,
    defaultContent,
    currentVersionId: manifest.currentVersionId,
    currentContent,
    versions: manifest.versions,
  };
}

/**
 * Read a specific version's content.
 *
 * `versionId === "default"` returns the bundled default.
 */
export async function getVersionContent(name: string, versionId: string): Promise<string> {
  assertManagedTemplate(name);
  if (!isVersionId(versionId)) {
    throw new Error(`Invalid version id: ${versionId}`);
  }
  if (versionId === DEFAULT_VERSION_ID) {
    return readDefaultContent(name);
  }
  // Verify the version exists in the manifest before reading the file
  // (defends against passing in a guessed id).
  const manifest = await readManifest(name);
  if (!manifest.versions.some((v) => v.id === versionId)) {
    throw new Error(`Version not found: ${versionId}`);
  }
  return readFile(versionFilePath(name, versionId), "utf-8");
}

/**
 * Save a new user version.
 *
 * `type` (item 6.8 round 2):
 * - `"full"` (default): body replaces the bundled default at promote
 *   time. Maximum flexibility; doesn't auto-pick-up cf² upgrades.
 * - `"augmented"`: body is appended to the live bundled default at
 *   promote/recompose time. Less flexibility; auto-picks-up upgrades.
 */
export async function saveVersion(
  name: string,
  opts: { label: string; content: string; type?: TemplateVersionType },
): Promise<TemplateVersion> {
  assertManagedTemplate(name);
  const label = opts.label.trim();
  if (!label) throw new Error("Version label cannot be empty");
  const content = opts.content;
  if (typeof content !== "string") throw new Error("Version content must be a string");
  const type: TemplateVersionType = opts.type ?? "full";
  if (type !== "full" && type !== "augmented") {
    throw new Error(`Invalid version type: ${type}. Must be "full" or "augmented".`);
  }

  await mkdir(templateDir(name), { recursive: true });
  const id = generateVersionId();
  await writeFile(versionFilePath(name, id), content, "utf-8");

  const version: TemplateVersion = {
    id,
    label,
    savedAt: new Date().toISOString(),
    contentHash: hashContent(content),
    type,
    cfcfVersion: VERSION,
  };

  const manifest = await readManifest(name);
  manifest.versions.push(version);
  await writeManifest(name, manifest);
  return version;
}

/**
 * Update a saved version's label or content (or both).
 */
export async function updateVersion(
  name: string,
  versionId: string,
  opts: { label?: string; content?: string },
): Promise<TemplateVersion> {
  assertManagedTemplate(name);
  if (versionId === DEFAULT_VERSION_ID) {
    throw new Error("The bundled default version is read-only");
  }
  if (!versionId.startsWith(VERSION_ID_PREFIX)) {
    throw new Error(`Invalid version id: ${versionId}`);
  }
  const manifest = await readManifest(name);
  const idx = manifest.versions.findIndex((v) => v.id === versionId);
  if (idx === -1) throw new Error(`Version not found: ${versionId}`);
  const existing = manifest.versions[idx];

  let nextLabel = existing.label;
  let nextHash = existing.contentHash;

  if (typeof opts.label === "string") {
    const label = opts.label.trim();
    if (!label) throw new Error("Version label cannot be empty");
    nextLabel = label;
  }
  if (typeof opts.content === "string") {
    await writeFile(versionFilePath(name, versionId), opts.content, "utf-8");
    nextHash = hashContent(opts.content);
    // If the user edits the currently-promoted version, refresh the
    // override file too so runtime picks up the change without a
    // separate re-promote step. For augmented versions, recompose
    // against the live bundled default.
    if (manifest.currentVersionId === versionId) {
      const composed = composeForOverride(name, existing.type, opts.content);
      await writeOverrideFile(name, composed);
    }
  }

  const updated: TemplateVersion = {
    ...existing,
    label: nextLabel,
    contentHash: nextHash,
  };
  manifest.versions[idx] = updated;
  await writeManifest(name, manifest);
  return updated;
}

/**
 * Delete a saved version. Cannot delete "default". If the deleted
 * version was the promoted one, automatically reverts to default.
 */
export async function deleteVersion(name: string, versionId: string): Promise<void> {
  assertManagedTemplate(name);
  if (versionId === DEFAULT_VERSION_ID) {
    throw new Error("Cannot delete the bundled default version");
  }
  if (!versionId.startsWith(VERSION_ID_PREFIX)) {
    throw new Error(`Invalid version id: ${versionId}`);
  }
  const manifest = await readManifest(name);
  const idx = manifest.versions.findIndex((v) => v.id === versionId);
  if (idx === -1) throw new Error(`Version not found: ${versionId}`);

  manifest.versions.splice(idx, 1);

  // If we deleted the promoted version, fall back to default.
  if (manifest.currentVersionId === versionId) {
    manifest.currentVersionId = DEFAULT_VERSION_ID;
    await deleteOverrideFile(name);
  }

  // Best-effort delete of the version file. Manifest write is the
  // canonical source of truth — if the file removal fails (read-only
  // FS, etc.) the manifest update is still saved.
  try {
    await rm(versionFilePath(name, versionId), { force: true });
  } catch {
    /* swallow */
  }

  await writeManifest(name, manifest);
}

/**
 * Promote a version (or "default") to production. Writes the override
 * file (or deletes it for "default") so `getTemplate()` picks up the
 * change for every subsequent agent spawn.
 *
 * For `type="augmented"` versions, the override file is the composed
 * `<bundled-default> + separator + <extension>`. For `type="full"`
 * versions, the override file is the body verbatim.
 */
export async function promoteVersion(name: string, versionId: string): Promise<void> {
  assertManagedTemplate(name);
  if (!isVersionId(versionId)) {
    throw new Error(`Invalid version id: ${versionId}`);
  }

  if (versionId === DEFAULT_VERSION_ID) {
    await deleteOverrideFile(name);
  } else {
    const manifest = await readManifest(name);
    const version = manifest.versions.find((v) => v.id === versionId);
    if (!version) {
      throw new Error(`Version not found: ${versionId}`);
    }
    const body = await readFile(versionFilePath(name, versionId), "utf-8");
    const composed = composeForOverride(name, version.type, body);
    await writeOverrideFile(name, composed);
  }

  const manifest = await readManifest(name);
  manifest.currentVersionId = versionId;
  await writeManifest(name, manifest);
}

/**
 * Compose the content that gets written to the override file for a
 * given version type.
 *
 * - `type === "full"`: pass-through. The user's body IS the override.
 * - `type === "augmented"`: `<bundled-default> + separator + <body>`.
 *   The bundled default is read live, so cf² upgrades automatically
 *   propagate the next time this function runs (promote OR boot
 *   refresh — see `refreshAugmentedOverrides`).
 */
function composeForOverride(name: string, type: TemplateVersionType, body: string): string {
  if (type === "augmented") {
    return getEmbeddedTemplate(name) + AUGMENTATION_SEPARATOR + body;
  }
  return body;
}

/**
 * Boot-time refresh (item 6.8 round 2): for every managed template
 * whose promoted version is augmented, re-compose `<bundled-default> +
 * separator + <extension>` and write to the override file if it
 * differs from what's already there. This is what makes cf²
 * upgrades transparent for augmented versions — when the bundled
 * default changes (because a new cf² version is installed), the
 * boot refresh picks up the new default automatically without any
 * user action.
 *
 * Only writes when content actually differs (cheap idempotent
 * recompose). Returns the count of templates whose override was
 * rewritten + any errors. Best-effort: per-template failures don't
 * stop the loop.
 *
 * Full versions are NOT touched — they're frozen by design (the user
 * has fully replaced the template; we have no safe way to merge
 * upgrades).
 */
export async function refreshAugmentedOverrides(): Promise<{
  refreshed: string[];
  errors: Array<{ name: string; error: string }>;
}> {
  const refreshed: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];
  for (const t of MANAGED_TEMPLATES) {
    try {
      const manifest = await readManifest(t.name);
      const currentId = manifest.currentVersionId;
      if (currentId === DEFAULT_VERSION_ID) continue;
      const version = manifest.versions.find((v) => v.id === currentId);
      if (!version || version.type !== "augmented") continue;

      const body = await readFile(versionFilePath(t.name, currentId), "utf-8");
      const composed = composeForOverride(t.name, "augmented", body);
      const overridePath = overrideFilePath(t.name);
      let onDisk: string | null = null;
      try {
        onDisk = await readFile(overridePath, "utf-8");
      } catch {
        onDisk = null;
      }
      if (onDisk !== composed) {
        await writeOverrideFile(t.name, composed);
        refreshed.push(t.name);
      }
    } catch (err) {
      errors.push({
        name: t.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { refreshed, errors };
}

// --- Override-file helpers ---

async function writeOverrideFile(name: string, content: string): Promise<void> {
  assertEmbeddedTemplate(name);
  const path = overrideFilePath(name);
  await mkdir(join(getConfigDir(), "templates"), { recursive: true });
  await writeFile(path, content, "utf-8");
}

async function deleteOverrideFile(name: string): Promise<void> {
  assertEmbeddedTemplate(name);
  const path = overrideFilePath(name);
  if (existsSync(path)) {
    await rm(path, { force: true });
  }
}

// --- Maintenance / diagnostics ---

/**
 * Detect manifest entries whose corresponding `v_<id>.md` file is
 * missing on disk. Useful for `cfcf doctor` and as a self-heal hook.
 */
export async function findOrphanedVersions(name: string): Promise<string[]> {
  const manifest = await readManifest(name);
  const orphans: string[] = [];
  let onDisk: string[] = [];
  try {
    const entries = await readdir(templateDir(name));
    onDisk = entries.filter((e) => e.startsWith(VERSION_ID_PREFIX) && e.endsWith(".md"))
      .map((e) => e.slice(0, -3));
  } catch {
    /* dir doesn't exist; every manifest version is orphaned */
  }
  for (const v of manifest.versions) {
    if (!onDisk.includes(v.id)) orphans.push(v.id);
  }
  return orphans;
}

// --- Shared internal export for templates.ts integration ---

export {
  DEFAULT_VERSION_ID,
  templatesManagedRoot,
};
