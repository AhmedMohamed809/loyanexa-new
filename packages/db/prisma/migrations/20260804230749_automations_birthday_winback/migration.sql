-- AlterTable
ALTER TABLE "Card" ADD COLUMN     "birthdayEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "birthdayMessage" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "winbackDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "winbackEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "winbackMessage" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Pass" ADD COLUMN     "birthdayDay" INTEGER,
ADD COLUMN     "birthdayMonth" INTEGER,
ADD COLUMN     "lastBirthdayAt" TIMESTAMPTZ(3),
ADD COLUMN     "lastWinbackAt" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "Pass_birthdayMonth_birthdayDay_idx" ON "Pass"("birthdayMonth", "birthdayDay");
