#!/usr/bin/env bun
/**
 * Read the runtime-dep version pins from packages/core/package.json and
 * substitute them into a target package.json under
 * `dependencies.<pkg>`. Used by stage-runtime-deps.sh so the staged
 * release tarball is always in lockstep with what packages/core ships.
 *
 * Usage:  resolve-runtime-deps.js <target-package-json>
 *
 * Reads ranges (e.g. "^4.2.0", "3.8.1") verbatim. The staging install
 * runs against these strings — Bun resolves them the same way it would
 * during normal dev install.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("usage: resolve-runtime-deps.js <target-package-json>");
  process.exit(1);
}

const repoRoot = resolve(import.meta.dir, "..");
const corePkgPath = resolve(repoRoot, "packages/core/package.json");
const corePkg = JSON.parse(readFileSync(corePkgPath, "utf8"));

// We pin ONLY @huggingface/transformers explicitly in the staging
// package.json. onnxruntime-node + sharp are transitive deps of
// transformers; pinning them as DIRECT deps here would override
// transformers' own version constraint and let "*" resolve to the
// latest npm release — which for onnxruntime-node would be 1.24.x
// (no darwin-x64; see decisions-log 2026-04-25 entry "Clio embedders:
// model-source, version pinning, and platform support" item 3).
//
// `bun install --linker hoisted` still places these transitive deps
// at the top of node_modules/ so cfcf's runtime resolver finds them
// via the standard Node walk-up. The flat layout is what we want for
// the tarball.
const RUNTIME_DEPS = ["@huggingface/transformers"];

const tgt = JSON.parse(readFileSync(target, "utf8"));
tgt.dependencies = tgt.dependencies ?? {};

for (const name of RUNTIME_DEPS) {
  const pinned = corePkg.dependencies?.[name];
  if (!pinned) {
    console.error(`[resolve-runtime-deps] FAIL: ${name} not declared in packages/core/package.json`);
    process.exit(1);
  }
  tgt.dependencies[name] = pinned;
}

writeFileSync(target, JSON.stringify(tgt, null, 2) + "\n");
console.log(`[resolve-runtime-deps] pinned in ${target}:`);
for (const name of RUNTIME_DEPS) {
  console.log(`  ${name}: ${tgt.dependencies[name]}`);
}
console.log(`[resolve-runtime-deps] (onnxruntime-node + sharp resolve transitively from transformers)`);
