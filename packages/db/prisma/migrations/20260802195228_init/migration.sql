-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('STARTER', 'GROWTH', 'PRO');

-- CreateEnum
CREATE TYPE "EventKind" AS ENUM ('ENROLL', 'STAMP', 'REWARD', 'REDEEM');

-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL,
    "firebaseUid" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'ar',
    "plan" "Plan" NOT NULL DEFAULT 'STARTER',
    "stripeCustId" TEXT,
    "subStatus" TEXT NOT NULL DEFAULT 'trialing',
    "trialEndsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Card" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "linkCode" INTEGER NOT NULL,
    "linkAlias" TEXT,
    "shortCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logoIconUrl" TEXT,
    "logoStampHash" TEXT,
    "coverUrl" TEXT,
    "coverHash" TEXT,
    "stampsGoal" INTEGER NOT NULL DEFAULT 8,
    "starterStamps" INTEGER NOT NULL DEFAULT 0,
    "stampShape" TEXT NOT NULL DEFAULT 'circle',
    "customStamps" BOOLEAN NOT NULL DEFAULT false,
    "bgColor" TEXT NOT NULL,
    "fgColor" TEXT NOT NULL,
    "stampActive" TEXT NOT NULL,
    "stampInactive" TEXT NOT NULL,
    "labelStamps" TEXT NOT NULL DEFAULT '',
    "labelRewards" TEXT NOT NULL DEFAULT '',
    "lang" TEXT NOT NULL DEFAULT 'ar',
    "expiryType" TEXT NOT NULL DEFAULT 'unlimited',
    "expiryDays" INTEGER,
    "expiryDate" TIMESTAMP(3),
    "rewardText" TEXT NOT NULL,
    "formFields" JSONB NOT NULL DEFAULT '["name","phone"]',
    "locations" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Card_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pass" (
    "id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "shortCode" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "authToken" TEXT NOT NULL,
    "custName" TEXT NOT NULL DEFAULT '',
    "custEmail" TEXT NOT NULL DEFAULT '',
    "custPhone" TEXT NOT NULL DEFAULT '',
    "custBirthday" TIMESTAMP(3),
    "stamps" INTEGER NOT NULL DEFAULT 0,
    "totalStamps" INTEGER NOT NULL DEFAULT 0,
    "rewards" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT NOT NULL DEFAULT '',
    "platform" TEXT NOT NULL DEFAULT '',
    "lastStampAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "deviceId" TEXT NOT NULL,
    "passSerial" TEXT NOT NULL,
    "pushToken" TEXT NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("deviceId","passSerial")
);

-- CreateTable
CREATE TABLE "StampEvent" (
    "id" BIGSERIAL NOT NULL,
    "merchantId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "kind" "EventKind" NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'browser',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StampEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinkCounter" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "value" INTEGER NOT NULL DEFAULT 10000,

    CONSTRAINT "LinkCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_firebaseUid_key" ON "Merchant"("firebaseUid");

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_email_key" ON "Merchant"("email");

-- CreateIndex
CREATE INDEX "Merchant_firebaseUid_idx" ON "Merchant"("firebaseUid");

-- CreateIndex
CREATE UNIQUE INDEX "Card_linkCode_key" ON "Card"("linkCode");

-- CreateIndex
CREATE UNIQUE INDEX "Card_linkAlias_key" ON "Card"("linkAlias");

-- CreateIndex
CREATE UNIQUE INDEX "Card_shortCode_key" ON "Card"("shortCode");

-- CreateIndex
CREATE INDEX "Card_linkCode_idx" ON "Card"("linkCode");

-- CreateIndex
CREATE INDEX "Card_linkAlias_idx" ON "Card"("linkAlias");

-- CreateIndex
CREATE UNIQUE INDEX "Card_merchantId_slot_key" ON "Card"("merchantId", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "Pass_serial_key" ON "Pass"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "Pass_shortCode_key" ON "Pass"("shortCode");

-- CreateIndex
CREATE INDEX "Pass_cardId_idx" ON "Pass"("cardId");

-- CreateIndex
CREATE INDEX "Pass_merchantId_lastStampAt_idx" ON "Pass"("merchantId", "lastStampAt");

-- CreateIndex
CREATE INDEX "Pass_updatedAt_idx" ON "Pass"("updatedAt");

-- CreateIndex
CREATE INDEX "Device_passSerial_idx" ON "Device"("passSerial");

-- CreateIndex
CREATE INDEX "StampEvent_merchantId_at_idx" ON "StampEvent"("merchantId", "at");

-- CreateIndex
CREATE INDEX "StampEvent_cardId_kind_idx" ON "StampEvent"("cardId", "kind");

-- AddForeignKey
ALTER TABLE "Card" ADD CONSTRAINT "Card_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pass" ADD CONSTRAINT "Pass_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_passSerial_fkey" FOREIGN KEY ("passSerial") REFERENCES "Pass"("serial") ON DELETE CASCADE ON UPDATE CASCADE;
