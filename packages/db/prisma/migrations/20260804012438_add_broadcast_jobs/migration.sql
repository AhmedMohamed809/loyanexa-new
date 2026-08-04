-- CreateTable
CREATE TABLE "BroadcastJob" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'manual',
    "message" TEXT NOT NULL,
    "pushMessage" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "recipientCount" INTEGER NOT NULL,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "BroadcastJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BroadcastRecipient" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "passSerial" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "claimedAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BroadcastRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BroadcastJob_merchantId_createdAt_idx" ON "BroadcastJob"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "BroadcastJob_status_idx" ON "BroadcastJob"("status");

-- CreateIndex
CREATE INDEX "BroadcastRecipient_status_nextAttemptAt_idx" ON "BroadcastRecipient"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "BroadcastRecipient_jobId_status_idx" ON "BroadcastRecipient"("jobId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BroadcastRecipient_jobId_passSerial_key" ON "BroadcastRecipient"("jobId", "passSerial");

-- AddForeignKey
ALTER TABLE "BroadcastJob" ADD CONSTRAINT "BroadcastJob_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastJob" ADD CONSTRAINT "BroadcastJob_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT "BroadcastRecipient_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BroadcastJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
