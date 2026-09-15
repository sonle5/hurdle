CREATE TABLE tae.runs (
  id text PRIMARY KEY CHECK (id ~ '^run_[a-f0-9-]{36}$'),
  current_revision integer NOT NULL CHECK (current_revision >= 0),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  state text NOT NULL CHECK (state IN ('queued', 'running', 'complete')),
  target_id text NOT NULL CHECK (target_id <> ''),
  created_at timestamptz NOT NULL,
  UNIQUE (id, current_revision)
);

CREATE TABLE tae.run_revisions (
  run_id text NOT NULL REFERENCES tae.runs(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision >= 0),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  written_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (run_id, revision),
  CHECK (record ->> 'id' = run_id),
  CHECK ((record ->> 'revision')::integer = revision)
);

ALTER TABLE tae.runs
  ADD CONSTRAINT tae_runs_current_revision_fk
  FOREIGN KEY (id, current_revision)
  REFERENCES tae.run_revisions(run_id, revision)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE tae.evidence_objects (
  run_id text NOT NULL REFERENCES tae.runs(id) ON DELETE RESTRICT,
  key text NOT NULL CHECK (key ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL
    CHECK (kind IN ('canonical-evidence', 'output-artifact')),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 67108864),
  sha256 text NOT NULL CHECK (sha256 = 'sha256:' || key),
  chunk_count integer NOT NULL CHECK (chunk_count BETWEEN 0 AND 16),
  published_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (run_id, key, kind),
  CHECK (kind = 'canonical-evidence' OR chunk_count = 0)
);

CREATE TABLE tae.evidence_chunks (
  run_id text NOT NULL,
  key text NOT NULL,
  kind text NOT NULL DEFAULT 'canonical-evidence'
    CHECK (kind = 'canonical-evidence'),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 4194304),
  PRIMARY KEY (run_id, key, kind, ordinal),
  FOREIGN KEY (run_id, key, kind)
    REFERENCES tae.evidence_objects(run_id, key, kind)
    ON DELETE RESTRICT
);

CREATE INDEX tae_runs_newest_idx
  ON tae.runs (created_at DESC, id COLLATE "C" DESC);

CREATE INDEX tae_runs_target_newest_idx
  ON tae.runs (target_id, created_at DESC, id COLLATE "C" DESC);
