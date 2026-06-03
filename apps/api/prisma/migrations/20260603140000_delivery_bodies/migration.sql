-- Capture the exact request body and full response per delivery; replace the
-- short `response_snippet` with a fuller `response_body`. SQLite table rebuild.
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_hook_deliveries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "run_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "row_index" INTEGER NOT NULL,
    "row_count" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "http_status" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "request_body" TEXT,
    "response_body" TEXT,
    "duration_ms" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "hook_deliveries_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "hook_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_hook_deliveries" ("id", "run_id", "sequence", "row_index", "row_count", "status", "http_status", "attempts", "error", "response_body", "duration_ms", "created_at")
SELECT "id", "run_id", "sequence", "row_index", "row_count", "status", "http_status", "attempts", "error", "response_snippet", "duration_ms", "created_at" FROM "hook_deliveries";

DROP TABLE "hook_deliveries";
ALTER TABLE "new_hook_deliveries" RENAME TO "hook_deliveries";

CREATE INDEX "hook_deliveries_run_id_idx" ON "hook_deliveries"("run_id");
CREATE UNIQUE INDEX "hook_deliveries_run_id_sequence_key" ON "hook_deliveries"("run_id", "sequence");

PRAGMA foreign_keys=ON;
