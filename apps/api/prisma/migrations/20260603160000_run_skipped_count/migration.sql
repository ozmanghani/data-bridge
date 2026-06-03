-- Track how many rows were skipped in a run.
ALTER TABLE "hook_runs" ADD COLUMN "skipped_count" INTEGER NOT NULL DEFAULT 0;
