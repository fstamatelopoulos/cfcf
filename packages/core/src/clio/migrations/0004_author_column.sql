-- 0004_author_column.sql -- plan item 5.12.
--
-- Add a typed `author` column to clio_documents so write attribution is
-- a first-class field (queryable, indexable) instead of being smuggled
-- through user-controlled metadata.json. Cerefox parity: the agent
-- quick-reference (`cerefox/AGENT_QUICK_REFERENCE.md`) requires every
-- ingest call to set `author`/`requestor`; cfcf now stores it.
--
-- Default value is 'agent' so PR1/5.11 callers (which never set author)
-- get a stable backfill without breaking changes. New ingest calls
-- override the default via IngestRequest.author.
--
-- The companion column on clio_document_versions is `source` (already
-- present from 5.7's schema) -- LocalClio's update path stores the
-- ingest's author there as the trigger label, mirroring Cerefox's
-- cerefox_document_versions.source semantics.

ALTER TABLE clio_documents ADD COLUMN author TEXT NOT NULL DEFAULT 'agent';

-- Indexed for the audit log + author-filtered queries we'll add in 5.13
-- (cfcf clio audit --author <name>) without forcing a JSON walk.
CREATE INDEX IF NOT EXISTS clio_documents_author_idx ON clio_documents(author);
