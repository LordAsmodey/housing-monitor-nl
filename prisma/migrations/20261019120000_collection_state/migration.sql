CREATE TABLE "SourceCollectionState" (
    "sourceId" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SourceCollectionState_pkey" PRIMARY KEY ("sourceId"),
    CONSTRAINT "SourceCollectionState_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "MonitoringRun" ADD COLUMN "collectionScope" TEXT;
