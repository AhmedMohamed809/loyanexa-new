-- Card designer: split the merchant's logo (wordmark, pass header + enrol
-- page) from the stamp icon (square-ish, fills a completed stamp slot) —
-- see schema.prisma's own comments on Card.logoUrl / Card.iconUrl for the
-- full reasoning. docs/BUILD.md §8.9 always described these as two separate
-- images ("logo · icon 512×512, required by Google Wallet · cover"); the
-- old logoIconUrl/logoStampHash/customStamps trio let a wordmark be used as
-- the stamp itself, which is illegible at stamp size — the design bug this
-- migration fixes.

-- 1. Rename the logo columns — same asset, corrected name.
ALTER TABLE "Card" RENAME COLUMN "logoIconUrl" TO "logoUrl";
ALTER TABLE "Card" RENAME COLUMN "logoStampHash" TO "logoHash";
-- 2. Rename the fit column — it now only ever applies to the icon.
ALTER TABLE "Card" RENAME COLUMN "logoFit" TO "iconFit";

-- 3. New columns: the icon (the merchant's own square-ish mark) and the
--    three-way stamp-source choice that replaces `customStamps`.
ALTER TABLE "Card" ADD COLUMN "iconUrl" TEXT;
ALTER TABLE "Card" ADD COLUMN "iconHash" TEXT;
ALTER TABLE "Card" ADD COLUMN "stampSource" TEXT NOT NULL DEFAULT 'builtin';
ALTER TABLE "Card" ADD COLUMN "builtinIcon" TEXT NOT NULL DEFAULT 'star';

-- 4. Migrate existing rows so a saved card's rendered appearance does not
--    silently change under it:
--    - customStamps = false rendered a plain disc — keep rendering a plain
--      disc (stampSource='plain'), not the new-card 'builtin' default.
UPDATE "Card" SET "stampSource" = 'plain' WHERE "customStamps" = false;
--    - customStamps = true used logoHash (ex-logoStampHash) as the stamp.
--      Where that stored image is roughly square, it was very likely
--      uploaded *for* the stamp rather than as a wordmark — carry it over
--      as the merchant's own icon so the card keeps looking the same.
UPDATE "Card" c
SET "iconUrl" = c."logoUrl", "iconHash" = c."logoHash", "stampSource" = 'icon'
FROM "CardImage" ci
WHERE c."customStamps" = true
  AND c."logoHash" = ci."hash"
  AND ci."width" > 0 AND ci."height" > 0
  AND ci."width"::float / ci."height"::float BETWEEN 0.8 AND 1.25;
--    - Any remaining customStamps = true row was a wordmark used as a
--      stamp — exactly the bug this migration fixes — so it falls back to
--      the new-card default of a drawn built-in icon (stampSource keeps
--      its column default of 'builtin' from step 3) rather than
--      perpetuating an illegible stamp. Its logoUrl/logoHash are untouched
--      and keep showing correctly in the pass header / enrol page.

-- 5. customStamps is fully replaced by stampSource.
ALTER TABLE "Card" DROP COLUMN "customStamps";
