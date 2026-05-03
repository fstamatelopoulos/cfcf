-- Migration 0002: FTS title boosting (item 6.24, Cerefox parity)
--
-- Replaces the 2-column clio_chunks_fts (chunk_title + content) with a
-- 3-column version (doc_title + chunk_title + content). searchFts() then
-- calls bm25(clio_chunks_fts, 4.0, 4.0, 1.0) so a query term that
-- matches a document title or a chunk heading outranks a body-only
-- match. Mirrors Cerefox's setweight A/B pattern -- their A:B ratio is
-- 2.5× via Postgres ts_rank_cd defaults; SQLite FTS5's per-column
-- bm25() weights are the equivalent knob (we use 4× as a slightly
-- stronger boost; tunable in searchFts()).
--
-- The doc_title column comes from clio_documents.title via JOINs in the
-- triggers below. Three trigger flows handle every path the index has
-- to follow:
--
--   1. New chunk inserted:  clio_chunks_fts_ai pulls doc_title via JOIN.
--   2. Chunk deleted alone: clio_chunks_fts_ad pulls old doc_title via
--      JOIN (still present at this point; the chunk-update path also
--      uses this).
--   3. Document hard-deleted: clio_documents_bd is a BEFORE DELETE
--      trigger that pre-clears the FTS for all current chunks while
--      the doc still has its title. The cascade-delete on clio_chunks
--      then fires _ad on rows that are already gone -- harmless no-op.
--   4. Document title renamed (cfcf clio docs edit --title): a separate
--      AFTER UPDATE OF title trigger refreshes the FTS for all current
--      chunks of that doc. Mirrors Cerefox's cerefox_update_chunk_fts
--      RPC.
--
-- Existing chunks are backfilled by the INSERT...SELECT below so the
-- migration is the upgrade path (no separate `cfcf clio reindex
-- --refts` flag needed).

-- Drop the old FTS table + its triggers from migration 0001.
DROP TRIGGER IF EXISTS clio_chunks_fts_ai;
DROP TRIGGER IF EXISTS clio_chunks_fts_ad;
DROP TRIGGER IF EXISTS clio_chunks_fts_au;
DROP TABLE IF EXISTS clio_chunks_fts;

-- New 3-column contentless FTS table. Column order matters: it sets the
-- order of arguments to bm25(clio_chunks_fts, w0, w1, w2) in searchFts().
CREATE VIRTUAL TABLE clio_chunks_fts USING fts5(
  doc_title,
  chunk_title,
  content,
  content='clio_chunks',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Backfill from current chunks (excluding archived versions and
-- soft-deleted docs, matching the index policy from migration 0001).
INSERT INTO clio_chunks_fts(rowid, doc_title, chunk_title, content)
  SELECT c.rowid,
         COALESCE(d.title, ''),
         COALESCE(c.title, ''),
         c.content
    FROM clio_chunks c
    JOIN clio_documents d ON c.document_id = d.id
   WHERE c.version_id IS NULL
     AND d.deleted_at IS NULL;

-- INSERT trigger: pull doc_title via JOIN to clio_documents.
CREATE TRIGGER clio_chunks_fts_ai AFTER INSERT ON clio_chunks
WHEN new.version_id IS NULL
BEGIN
  INSERT INTO clio_chunks_fts(rowid, doc_title, chunk_title, content)
    SELECT new.rowid,
           COALESCE(d.title, ''),
           COALESCE(new.title, ''),
           new.content
      FROM clio_documents d
     WHERE d.id = new.document_id;
END;

-- DELETE trigger (chunk standalone delete, e.g. update-replace-all-chunks).
-- Uses JOIN so doc_title comes from the live row. If the doc is already
-- gone (cascade delete from clio_documents), the SELECT yields zero rows
-- and the INSERT is a no-op -- the BEFORE DELETE on clio_documents below
-- has already cleared the FTS rows.
CREATE TRIGGER clio_chunks_fts_ad AFTER DELETE ON clio_chunks
WHEN old.version_id IS NULL
BEGIN
  INSERT INTO clio_chunks_fts(clio_chunks_fts, rowid, doc_title, chunk_title, content)
    SELECT 'delete', old.rowid, COALESCE(d.title, ''), COALESCE(old.title, ''), old.content
      FROM clio_documents d
     WHERE d.id = old.document_id;
END;

-- UPDATE trigger.
CREATE TRIGGER clio_chunks_fts_au AFTER UPDATE ON clio_chunks
WHEN old.version_id IS NULL OR new.version_id IS NULL
BEGIN
  INSERT INTO clio_chunks_fts(clio_chunks_fts, rowid, doc_title, chunk_title, content)
    SELECT 'delete', old.rowid, COALESCE(d.title, ''), COALESCE(old.title, ''), old.content
      FROM clio_documents d
     WHERE d.id = old.document_id AND old.version_id IS NULL;
  INSERT INTO clio_chunks_fts(rowid, doc_title, chunk_title, content)
    SELECT new.rowid, COALESCE(d.title, ''), COALESCE(new.title, ''), new.content
      FROM clio_documents d
     WHERE d.id = new.document_id AND new.version_id IS NULL;
END;

-- BEFORE DELETE on clio_documents: clear the FTS rows for all current
-- chunks before the cascade-delete on clio_chunks fires. Required because
-- the chunk_fts_ad trigger can't reconstruct doc_title via JOIN once the
-- doc is gone.
CREATE TRIGGER clio_documents_fts_bd BEFORE DELETE ON clio_documents
BEGIN
  INSERT INTO clio_chunks_fts(clio_chunks_fts, rowid, doc_title, chunk_title, content)
    SELECT 'delete', c.rowid, COALESCE(old.title, ''), COALESCE(c.title, ''), c.content
      FROM clio_chunks c
     WHERE c.document_id = old.id
       AND c.version_id IS NULL;
END;

-- AFTER UPDATE OF title on clio_documents: refresh FTS doc_title for all
-- current chunks of the renamed doc. Mirrors Cerefox's
-- cerefox_update_chunk_fts RPC. Title-only update (no chunk content
-- change) -- no version snapshot, no chunk row touched. WHEN clause
-- skips no-op title writes.
CREATE TRIGGER clio_documents_fts_title_au
AFTER UPDATE OF title ON clio_documents
WHEN COALESCE(old.title, '') != COALESCE(new.title, '')
BEGIN
  INSERT INTO clio_chunks_fts(clio_chunks_fts, rowid, doc_title, chunk_title, content)
    SELECT 'delete', c.rowid, COALESCE(old.title, ''), COALESCE(c.title, ''), c.content
      FROM clio_chunks c
     WHERE c.document_id = new.id
       AND c.version_id IS NULL;
  INSERT INTO clio_chunks_fts(rowid, doc_title, chunk_title, content)
    SELECT c.rowid, COALESCE(new.title, ''), COALESCE(c.title, ''), c.content
      FROM clio_chunks c
     WHERE c.document_id = new.id
       AND c.version_id IS NULL;
END;
