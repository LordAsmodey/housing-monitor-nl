CREATE TABLE "TelegramUpdateCursor" (
    "id" TEXT NOT NULL,
    "offset" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "TelegramUpdateCursor_pkey" PRIMARY KEY ("id")
);
