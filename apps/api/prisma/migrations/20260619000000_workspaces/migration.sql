-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- Seed the default workspace that every install starts with.
INSERT INTO "workspaces" ("id", "name", "updated_at")
VALUES ('00000000-0000-0000-0000-000000000001', 'Default workspace', CURRENT_TIMESTAMP);

-- Add workspace_id to existing tables, backfilling current rows to the default
-- workspace via a temporary column default, then dropping the default so future
-- inserts must set it explicitly.
ALTER TABLE "connections" ADD COLUMN "workspace_id" TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE "connections" ALTER COLUMN "workspace_id" DROP DEFAULT;

ALTER TABLE "hooks" ADD COLUMN "workspace_id" TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE "hooks" ALTER COLUMN "workspace_id" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "connections_workspace_id_idx" ON "connections"("workspace_id");
CREATE INDEX "hooks_workspace_id_idx" ON "hooks"("workspace_id");

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hooks" ADD CONSTRAINT "hooks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
