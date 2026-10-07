ALTER SCHEMA tae RENAME TO hurdle;

ALTER TABLE hurdle.runs
  RENAME CONSTRAINT tae_runs_current_revision_fk TO hurdle_runs_current_revision_fk;

ALTER INDEX hurdle.tae_runs_newest_idx RENAME TO hurdle_runs_newest_idx;
ALTER INDEX hurdle.tae_runs_target_newest_idx RENAME TO hurdle_runs_target_newest_idx;
