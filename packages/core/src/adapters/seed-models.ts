/**
 * Seed model registry per agent adapter (item 6.26).
 *
 * Hardcoded list of "well-known" models that each agent CLI accepts as
 * its `--model` value. Intentionally minimal: aliases (where the adapter
 * supports them) over date-bound full names so the seed ages slowly --
 * "opus" always points at the latest Opus, "sonnet" at the latest
 * Sonnet, etc., per the upstream-CLI convention.
 *
 * **Augment, don't replace, in cfcf source.** Users override via the
 * Settings → Model registry editor; their list is stored on
 * `CfcfGlobalConfig.agentModels[<adapterName>]` and supersedes this seed
 * via `resolveModelsForAdapter()`. The "Custom model name…" sentinel in
 * every web + CLI picker also lets users one-shot a model that's in
 * neither list.
 *
 * **Maintenance**: when Anthropic / OpenAI / etc. ship a new model that's
 * worth surfacing as a default, edit the relevant adapter's array below
 * and ship in the next cfcf release. Per-user augmentations survive
 * upgrades because they live on the user's config, not in the seed.
 *
 * Why no remote registry? See the 6.26 design discussion: hosting an
 * online registry shifts maintenance responsibility onto cfcf
 * maintainers (model-list curation, rate-limiting, availability).
 * Pre-seeded + user-overridable side-steps that. The "Custom model
 * name…" fallback handles the long tail.
 */

export type SeedModelMap = Record<string, string[]>;

export const SEED_MODELS: SeedModelMap = {
  // Claude Code recognises three stable aliases that always resolve to
  // the latest model in their tier. Full names like
  // "claude-sonnet-4-6" also work but go stale fast; users add them via
  // Settings if they need to pin.
  // Ref: https://docs.anthropic.com/en/docs/about-claude/models
  "claude-code": ["opus", "sonnet", "haiku"],

  // Codex's `--model` accepts model NAMES (no aliases like Claude).
  // Seeded with the current production-grade Codex + general models;
  // the long tail of variants (mini sizes, dated builds) goes via the
  // Settings editor or the "Custom model name…" picker option.
  // Ref: https://platform.openai.com/docs/models
  "codex": ["gpt-5-codex", "gpt-5", "o3"],
};

/** Returns the seed models for an adapter, or [] if none seeded. */
export function getSeedModels(adapterName: string): string[] {
  return SEED_MODELS[adapterName] ?? [];
}
