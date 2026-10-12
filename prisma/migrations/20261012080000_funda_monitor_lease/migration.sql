ALTER TABLE "Source"
ADD COLUMN "nextCheckAt" TIMESTAMP(3),
ADD COLUMN "monitorLeaseUntil" TIMESTAMP(3),
ADD COLUMN "monitorLeaseToken" TEXT;
