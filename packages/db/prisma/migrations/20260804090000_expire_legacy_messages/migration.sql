-- Retires broadcast messages left on passes from before ephemeral
-- notifications existed (sub-project 9).
--
-- Those rows have a non-empty `message` and a NULL `messageExpiresAt`,
-- because nothing stamped an expiry when they were written. The original
-- predicate in apps/demo/passContent.ts read a NULL expiry as "never
-- expires", which exempted exactly these rows from the feature: on the live
-- database, 9 of the 12 passes carrying a message were set to display a
-- months-old broadcast permanently. That is the owner's original report
-- ("it's showing all the previous notification") for every customer who
-- already had a card.
--
-- The code now reads NULL as expired and the sweeper clears such rows, so
-- this backfill is not strictly required for correctness. It runs anyway so
-- the fix is immediate and does not depend on the sweeper's next tick, and
-- so the database matches what the passes render.
--
-- Deliberately does NOT touch rows with a real future expiry — those are
-- live broadcasts a merchant sent minutes ago, and clearing them would
-- retract a message customers are meant to be reading right now.
UPDATE "Pass"
SET message = '', "messageExpiresAt" = NULL
WHERE message <> '' AND "messageExpiresAt" IS NULL;
