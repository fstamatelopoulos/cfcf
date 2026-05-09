/**
 * Tests for the role-template management layer (item 6.8).
 *
 * Covers:
 * - listing managed templates
 * - reading the bundled default vs user versions
 * - save / update / delete / promote / revert flows
 * - the override-file write/delete that hooks into the existing
 *   `getTemplate()` resolution chain
 * - manifest corruption recovery
 * - orphan-version detection
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listManagedTemplateNames,
  listManagedTemplates,
  getManagedTemplate,
  getVersionContent,
  saveVersion,
  updateVersion,
  deleteVersion,
  promoteVersion,
  refreshAugmentedOverrides,
  findOrphanedVersions,
  AUGMENTATION_SEPARATOR,
  DEFAULT_VERSION_ID,
} from "./role-templates.js";
import { getTemplate, getEmbeddedTemplate } from "./templates.js";

let tmpDir: string;
let originalEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cfcf-role-tpl-"));
  originalEnv = process.env.CFCF_CONFIG_DIR;
  process.env.CFCF_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.CFCF_CONFIG_DIR;
  else process.env.CFCF_CONFIG_DIR = originalEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

const JUDGE = "cfcf-judge-instructions.md";
const ARCHITECT = "cfcf-architect-instructions.md";

describe("listManagedTemplateNames", () => {
  test("includes the four iteration roles + process template", () => {
    const names = listManagedTemplateNames().map((t) => t.name);
    expect(names).toContain("cfcf-architect-instructions.md");
    expect(names).toContain("cfcf-judge-instructions.md");
    expect(names).toContain("cfcf-documenter-instructions.md");
    expect(names).toContain("cfcf-reflection-instructions.md");
    expect(names).toContain("process.md");
  });

  test("provides display names for each", () => {
    const items = listManagedTemplateNames();
    for (const t of items) {
      expect(t.displayName.length).toBeGreaterThan(0);
    }
  });
});

describe("listManagedTemplates", () => {
  test("returns one summary per managed template, all on default initially", async () => {
    const summaries = await listManagedTemplates();
    expect(summaries.length).toBe(listManagedTemplateNames().length);
    for (const s of summaries) {
      expect(s.currentVersionId).toBe("default");
      expect(s.versionCount).toBe(0);
    }
  });
});

describe("getManagedTemplate", () => {
  test("returns the bundled default content + empty versions list initially", async () => {
    const t = await getManagedTemplate(JUDGE);
    expect(t.name).toBe(JUDGE);
    expect(t.displayName).toBe("Judge");
    expect(t.currentVersionId).toBe("default");
    expect(t.versions).toEqual([]);
    expect(t.defaultContent).toBe(getEmbeddedTemplate(JUDGE));
    expect(t.currentContent).toBe(t.defaultContent);
  });

  test("rejects unknown template names", async () => {
    expect(getManagedTemplate("nonexistent.md")).rejects.toThrow();
  });

  test("rejects template names that exist in EMBEDDED but aren't in the managed list", async () => {
    // `iteration-handoff.md` is embedded but is internal scaffolding —
    // not in MANAGED_TEMPLATES, so it should not be manageable.
    expect(getManagedTemplate("iteration-handoff.md")).rejects.toThrow();
  });
});

describe("saveVersion", () => {
  test("creates a version, persists content, and adds to manifest", async () => {
    const v = await saveVersion(JUDGE, { label: "stricter judge", content: "## Custom\nBe strict." });
    expect(v.id).toMatch(/^v_/);
    expect(v.label).toBe("stricter judge");
    expect(v.savedAt).toMatch(/T/); // ISO
    expect(v.contentHash.length).toBe(12);
    // Round 2: type defaults to "full" + cfcfVersion stamped
    expect(v.type).toBe("full");
    expect(typeof v.cfcfVersion).toBe("string");

    const managed = await getManagedTemplate(JUDGE);
    expect(managed.versions).toHaveLength(1);
    expect(managed.versions[0]).toEqual(v);
    // Promoted is still default until explicitly promoted.
    expect(managed.currentVersionId).toBe("default");
  });

  test("creates an augmented version when type='augmented' is passed", async () => {
    const v = await saveVersion(JUDGE, {
      label: "with project hints",
      content: "Always reference Linear ticket IDs in summaries.",
      type: "augmented",
    });
    expect(v.type).toBe("augmented");
    // The body file holds ONLY the extension (no bundled default).
    const stored = await getVersionContent(JUDGE, v.id);
    expect(stored).toBe("Always reference Linear ticket IDs in summaries.");
  });

  test("rejects invalid type values", async () => {
    expect(
      saveVersion(JUDGE, { label: "x", content: "y", type: "patch" as never }),
    ).rejects.toThrow();
  });

  test("rejects empty labels", async () => {
    expect(saveVersion(JUDGE, { label: "  ", content: "x" })).rejects.toThrow();
  });

  test("multiple saves produce distinct ids", async () => {
    const v1 = await saveVersion(JUDGE, { label: "a", content: "A" });
    const v2 = await saveVersion(JUDGE, { label: "b", content: "B" });
    expect(v1.id).not.toBe(v2.id);
    const managed = await getManagedTemplate(JUDGE);
    expect(managed.versions.map((v) => v.id).sort()).toEqual([v1.id, v2.id].sort());
  });
});

describe("getVersionContent", () => {
  test("returns the bundled default for 'default'", async () => {
    const content = await getVersionContent(JUDGE, DEFAULT_VERSION_ID);
    expect(content).toBe(getEmbeddedTemplate(JUDGE));
  });

  test("returns the saved content for a real version id", async () => {
    const v = await saveVersion(JUDGE, { label: "x", content: "saved body" });
    const content = await getVersionContent(JUDGE, v.id);
    expect(content).toBe("saved body");
  });

  test("rejects unknown version ids", async () => {
    expect(getVersionContent(JUDGE, "v_doesnotexist")).rejects.toThrow();
  });

  test("rejects malformed version ids", async () => {
    expect(getVersionContent(JUDGE, "not-a-version-id")).rejects.toThrow();
  });
});

describe("promoteVersion", () => {
  test("writing the override file makes getTemplate() pick it up", async () => {
    const v = await saveVersion(JUDGE, { label: "custom", content: "MY CUSTOM JUDGE" });
    await promoteVersion(JUDGE, v.id);

    // The override file must exist now.
    const overridePath = join(tmpDir, "templates", JUDGE);
    expect(existsSync(overridePath)).toBe(true);
    expect(readFileSync(overridePath, "utf-8")).toBe("MY CUSTOM JUDGE");

    // getTemplate must return the override content.
    const resolved = await getTemplate(JUDGE);
    expect(resolved).toBe("MY CUSTOM JUDGE");

    // Manifest reflects the promoted version.
    const managed = await getManagedTemplate(JUDGE);
    expect(managed.currentVersionId).toBe(v.id);
    expect(managed.currentContent).toBe("MY CUSTOM JUDGE");
  });

  test("promoting 'default' deletes the override file and reverts to embedded", async () => {
    const v = await saveVersion(JUDGE, { label: "x", content: "OVERRIDE" });
    await promoteVersion(JUDGE, v.id);
    expect(existsSync(join(tmpDir, "templates", JUDGE))).toBe(true);

    await promoteVersion(JUDGE, DEFAULT_VERSION_ID);
    expect(existsSync(join(tmpDir, "templates", JUDGE))).toBe(false);

    const resolved = await getTemplate(JUDGE);
    expect(resolved).toBe(getEmbeddedTemplate(JUDGE));
  });

  test("promoting an unknown version id throws", async () => {
    expect(promoteVersion(JUDGE, "v_unknown")).rejects.toThrow();
  });
});

describe("updateVersion", () => {
  test("updates label only", async () => {
    const v = await saveVersion(JUDGE, { label: "old", content: "body" });
    const updated = await updateVersion(JUDGE, v.id, { label: "new label" });
    expect(updated.label).toBe("new label");
    expect(updated.contentHash).toBe(v.contentHash); // content unchanged
    const content = await getVersionContent(JUDGE, v.id);
    expect(content).toBe("body");
  });

  test("updates content only and refreshes hash", async () => {
    const v = await saveVersion(JUDGE, { label: "x", content: "before" });
    const updated = await updateVersion(JUDGE, v.id, { content: "after" });
    expect(updated.contentHash).not.toBe(v.contentHash);
    const content = await getVersionContent(JUDGE, v.id);
    expect(content).toBe("after");
  });

  test("editing the promoted version refreshes the override file", async () => {
    const v = await saveVersion(JUDGE, { label: "x", content: "v1" });
    await promoteVersion(JUDGE, v.id);
    expect(readFileSync(join(tmpDir, "templates", JUDGE), "utf-8")).toBe("v1");

    await updateVersion(JUDGE, v.id, { content: "v2" });
    expect(readFileSync(join(tmpDir, "templates", JUDGE), "utf-8")).toBe("v2");
  });

  test("rejects updating the bundled default", async () => {
    expect(updateVersion(JUDGE, DEFAULT_VERSION_ID, { label: "x" })).rejects.toThrow();
  });

  test("rejects empty label", async () => {
    const v = await saveVersion(JUDGE, { label: "x", content: "body" });
    expect(updateVersion(JUDGE, v.id, { label: "  " })).rejects.toThrow();
  });
});

describe("deleteVersion", () => {
  test("removes the version + manifest entry + content file", async () => {
    const v = await saveVersion(JUDGE, { label: "x", content: "body" });
    await deleteVersion(JUDGE, v.id);
    const managed = await getManagedTemplate(JUDGE);
    expect(managed.versions).toHaveLength(0);
  });

  test("deleting the promoted version reverts to default automatically", async () => {
    const v = await saveVersion(JUDGE, { label: "x", content: "promoted" });
    await promoteVersion(JUDGE, v.id);
    expect(existsSync(join(tmpDir, "templates", JUDGE))).toBe(true);

    await deleteVersion(JUDGE, v.id);
    const managed = await getManagedTemplate(JUDGE);
    expect(managed.currentVersionId).toBe("default");
    // Override file deleted.
    expect(existsSync(join(tmpDir, "templates", JUDGE))).toBe(false);
  });

  test("rejects deleting the bundled default", async () => {
    expect(deleteVersion(JUDGE, DEFAULT_VERSION_ID)).rejects.toThrow();
  });
});

describe("isolation between templates", () => {
  test("a version on judge doesn't appear under architect", async () => {
    await saveVersion(JUDGE, { label: "x", content: "judge content" });
    const arch = await getManagedTemplate(ARCHITECT);
    expect(arch.versions).toHaveLength(0);
  });

  test("promoting one template doesn't write the other's override file", async () => {
    const v = await saveVersion(JUDGE, { label: "x", content: "judge" });
    await promoteVersion(JUDGE, v.id);
    expect(existsSync(join(tmpDir, "templates", ARCHITECT))).toBe(false);
  });
});

describe("findOrphanedVersions", () => {
  test("returns ids whose v_*.md file was deleted out of band", async () => {
    const v1 = await saveVersion(JUDGE, { label: "a", content: "A" });
    const v2 = await saveVersion(JUDGE, { label: "b", content: "B" });
    // Manually nuke v1's content file.
    rmSync(join(tmpDir, "templates-managed", JUDGE, `${v1.id}.md`));
    const orphans = await findOrphanedVersions(JUDGE);
    expect(orphans).toEqual([v1.id]);
    // v2 still on disk.
    expect(orphans).not.toContain(v2.id);
  });

  test("returns empty list when everything is consistent", async () => {
    await saveVersion(JUDGE, { label: "a", content: "A" });
    const orphans = await findOrphanedVersions(JUDGE);
    expect(orphans).toEqual([]);
  });
});

describe("manifest corruption recovery", () => {
  test("a malformed manifest returns the empty default state without throwing", async () => {
    // Manually scaffold a corrupt manifest.
    const dir = join(tmpDir, "templates-managed", JUDGE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), "{ broken json", "utf-8");
    const managed = await getManagedTemplate(JUDGE);
    expect(managed.currentVersionId).toBe("default");
    expect(managed.versions).toEqual([]);
  });
});

describe("self-heal: stale promoted-version pointer", () => {
  test("if the manifest points at a missing v_*.md, currentContent falls back to default", async () => {
    const v = await saveVersion(JUDGE, { label: "x", content: "promoted" });
    await promoteVersion(JUDGE, v.id);
    // Externally remove the version content file but leave the manifest intact.
    rmSync(join(tmpDir, "templates-managed", JUDGE, `${v.id}.md`));
    const managed = await getManagedTemplate(JUDGE);
    // The currentContent must fall back to default rather than throw.
    expect(managed.currentContent).toBe(getEmbeddedTemplate(JUDGE));
  });
});

describe("augmented type — round 2 composition + boot refresh", () => {
  test("promoting an augmented version writes <default> + separator + <extension> to the override", async () => {
    const ext = "Project-specific: cite Linear ticket in every summary.";
    const v = await saveVersion(JUDGE, { label: "linear-augmented", content: ext, type: "augmented" });
    await promoteVersion(JUDGE, v.id);

    const overridePath = join(tmpDir, "templates", JUDGE);
    expect(existsSync(overridePath)).toBe(true);
    const onDisk = readFileSync(overridePath, "utf-8");
    const expected = getEmbeddedTemplate(JUDGE) + AUGMENTATION_SEPARATOR + ext;
    expect(onDisk).toBe(expected);

    // getTemplate() returns the composed version too.
    const resolved = await getTemplate(JUDGE);
    expect(resolved).toBe(expected);
  });

  test("editing the promoted augmented version recomposes against the live default", async () => {
    const v = await saveVersion(JUDGE, {
      label: "v1",
      content: "ext-v1",
      type: "augmented",
    });
    await promoteVersion(JUDGE, v.id);

    await updateVersion(JUDGE, v.id, { content: "ext-v2" });
    const onDisk = readFileSync(join(tmpDir, "templates", JUDGE), "utf-8");
    expect(onDisk).toBe(getEmbeddedTemplate(JUDGE) + AUGMENTATION_SEPARATOR + "ext-v2");
  });

  test("promoting 'default' over an augmented version deletes the override file", async () => {
    const v = await saveVersion(JUDGE, { label: "x", content: "ext", type: "augmented" });
    await promoteVersion(JUDGE, v.id);
    expect(existsSync(join(tmpDir, "templates", JUDGE))).toBe(true);

    await promoteVersion(JUDGE, DEFAULT_VERSION_ID);
    expect(existsSync(join(tmpDir, "templates", JUDGE))).toBe(false);
  });

  test("getVersionContent returns the EXTENSION only for augmented versions (not the composed text)", async () => {
    const v = await saveVersion(JUDGE, {
      label: "x",
      content: "extension only",
      type: "augmented",
    });
    const content = await getVersionContent(JUDGE, v.id);
    expect(content).toBe("extension only");
  });
});

describe("refreshAugmentedOverrides (boot-time refresh)", () => {
  test("rewrites a stale augmented override (simulating a cf² upgrade where the default changed)", async () => {
    const ext = "my custom directions";
    const v = await saveVersion(JUDGE, { label: "x", content: ext, type: "augmented" });
    await promoteVersion(JUDGE, v.id);
    // Simulate cf² upgrade: the override on disk reflects the OLD
    // composed content. We mimic that by clobbering the override with
    // a stale composition (the bundled default has "drifted" to a new
    // value the user hasn't seen).
    const stalePath = join(tmpDir, "templates", JUDGE);
    writeFileSync(stalePath, "OLD DEFAULT" + AUGMENTATION_SEPARATOR + ext, "utf-8");

    const result = await refreshAugmentedOverrides();
    expect(result.refreshed).toContain(JUDGE);

    const fresh = readFileSync(stalePath, "utf-8");
    expect(fresh).toBe(getEmbeddedTemplate(JUDGE) + AUGMENTATION_SEPARATOR + ext);
  });

  test("no-op when the on-disk content already matches the composed text (idempotent)", async () => {
    const v = await saveVersion(JUDGE, {
      label: "x",
      content: "ext",
      type: "augmented",
    });
    await promoteVersion(JUDGE, v.id);

    const result = await refreshAugmentedOverrides();
    // Just promoted → already up to date → not refreshed again.
    expect(result.refreshed).not.toContain(JUDGE);
  });

  test("does NOT touch full versions (they're frozen by design)", async () => {
    const v = await saveVersion(JUDGE, { label: "x", content: "FULL CUSTOM", type: "full" });
    await promoteVersion(JUDGE, v.id);
    // Even if the bundled default changes, full versions keep their content.
    // Simulate a stale override (user's hand-edited the file, etc.).
    const overridePath = join(tmpDir, "templates", JUDGE);
    writeFileSync(overridePath, "FULL CUSTOM (out of sync but user owns this)", "utf-8");

    const result = await refreshAugmentedOverrides();
    expect(result.refreshed).not.toContain(JUDGE);
    // Override file untouched.
    expect(readFileSync(overridePath, "utf-8")).toBe(
      "FULL CUSTOM (out of sync but user owns this)",
    );
  });

  test("does NOT touch templates whose currentVersionId is 'default'", async () => {
    // No version saved + promoted → boot refresh is a no-op.
    const result = await refreshAugmentedOverrides();
    expect(result.refreshed).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

describe("back-compat: round-1 manifests without `type`", () => {
  test("a manifest written by round-1 code (no type field) loads as type='full'", async () => {
    // Manually scaffold a round-1-shaped manifest.
    const dir = join(tmpDir, "templates-managed", JUDGE);
    mkdirSync(dir, { recursive: true });
    const v_id = "v_legacy";
    writeFileSync(join(dir, `${v_id}.md`), "legacy body", "utf-8");
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        currentVersionId: "default",
        versions: [
          {
            id: v_id,
            label: "legacy",
            savedAt: "2026-01-01T00:00:00Z",
            contentHash: "abc",
            // no type, no cfcfVersion
          },
        ],
      }),
      "utf-8",
    );

    const managed = await getManagedTemplate(JUDGE);
    expect(managed.versions[0].type).toBe("full");
    // Promoting a back-compat full version keeps current behaviour.
    await promoteVersion(JUDGE, v_id);
    const onDisk = readFileSync(join(tmpDir, "templates", JUDGE), "utf-8");
    expect(onDisk).toBe("legacy body");
  });
});
