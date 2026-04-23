-- Active-embedder tracking (plan item 5.7 PR2).
--
-- Clio pins one embedder per DB. The active record records the name,
-- dim, and install timestamp so `cfcf clio embedder active` can report
-- it + so the ingest path knows which model to load. Switching
-- embedders post-install is gated by `cfcf clio embedder set` (PR2+).

CREATE TABLE IF NOT EXISTS clio_active_embedder (
  -- Single-row table: enforced via a CHECK on id=1. Matches how Cerefox
  -- tracks single-value state.
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  name            TEXT NOT NULL,
  dim             INTEGER NOT NULL,
  hf_model_id     TEXT NOT NULL,
  recommended_chunk_max_chars  INTEGER NOT NULL,
  recommended_expansion_radius INTEGER NOT NULL,
  installed_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
