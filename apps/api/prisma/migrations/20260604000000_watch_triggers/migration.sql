-- Watch (live-listening) hooks: a trigger config per hook, and a per-run
-- change-detection cursor.
ALTER TABLE "hooks" ADD COLUMN "trigger_json" TEXT;
ALTER TABLE "hook_runs" ADD COLUMN "cursor_json" TEXT;
