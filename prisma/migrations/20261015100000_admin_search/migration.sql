ALTER TABLE "MonitoringRun" ADD COLUMN "searchRevision" INTEGER, ADD COLUMN "searchSnapshot" JSONB;
CREATE TABLE "SearchConfiguration" (
  "sourceId" TEXT PRIMARY KEY REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "ownerKey" TEXT NOT NULL DEFAULT 'admin', "enabled" BOOLEAN NOT NULL DEFAULT true,
  "filters" JSONB NOT NULL, "revision" INTEGER NOT NULL DEFAULT 1,
  "appliedRevision" INTEGER NOT NULL DEFAULT 1, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "SearchChange" (
  "id" TEXT PRIMARY KEY, "sourceId" TEXT NOT NULL REFERENCES "SearchConfiguration"("sourceId") ON DELETE CASCADE ON UPDATE CASCADE,
  "revision" INTEGER NOT NULL, "enabled" BOOLEAN NOT NULL, "filters" JSONB NOT NULL,
  "actor" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "SearchChange_sourceId_revision_key" ON "SearchChange"("sourceId", "revision");
CREATE TABLE "AdminSession" ("tokenHash" TEXT PRIMARY KEY, "csrf" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL);
CREATE INDEX "AdminSession_expiresAt_idx" ON "AdminSession"("expiresAt");
