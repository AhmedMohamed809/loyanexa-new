# Backups and restore

**Last restore test: 5 August 2026 — passed.** See "The test that was actually run" below.

BUILD.md §15 Phase 7 asks for "Daily Postgres backups, **restore tested at least once**".
This file records what exists, what does not, and exactly how to get the data back.

---

## What exists today

| | |
|---|---|
| **Fly volume snapshots** | Automatic, daily, **5-day retention**, on `vol_vlyk8q296djoooo4` (app `loyanexa-db`). Nobody configured these — Fly does it. |
| **Logical dumps** | `scripts/backup-db.sh`. Not yet scheduled. |
| **Offsite copy** | **None.** See "What is still missing". |

### What the volume snapshots are not

They are a real safety net and they are better than nothing. They are not a backup strategy:

- **Five days.** Corruption or a bad migration noticed on the sixth day is unrecoverable.
- **Same provider, same region.** They do not survive losing the Fly account, and they are
  not a second copy in any meaningful sense.
- **Block-level, not logical.** A snapshot restores a whole volume. It cannot give you "the
  `Card` table as it was on Tuesday", and it cannot be restored into a different Postgres
  version or onto a different host.
- **Crash-consistent, not clean.** A snapshot of a running Postgres is equivalent to pulling
  the power. Postgres replays its WAL on start and this is normally fine — but "normally" is
  doing work in that sentence.

A `pg_dump` is portable, inspectable, and restorable anywhere. Keep both.

---

## The test that was actually run

On 5 August 2026, against the live database:

1. `pg_dump -Fc` of `loyanexa_new` → 27 MB
2. `pg_restore -l` to prove the dump opens and lists its objects — 13 tables with data
3. Restored into a scratch database `restore_test` **on the same server**, live database
   untouched
4. Compared row counts, live vs restored: `1/9/52/71/31`
   (Merchant / Card / Pass / StampEvent / CardImage) — **identical**
5. Compared image bytes, not just row counts: `24,562,996` both sides — **identical**
6. Spot-checked real passes with their card names and stamp counts — present and correct
7. Dropped the scratch database, removed the dump

### What the test found

**The first attempt killed the database.**

```
pg_dump: error: Dumping the contents of table "CardImage" failed: PQgetCopyData() failed.
pg_dump: detail: server closed the connection unexpectedly
...
Out of memory: Killed process 22103 (postgres)
```

The database machine had **256 MB** of RAM and ~12 MB free at rest. `CardImage` holds
**24 MB of image blobs — 99% of the entire database** — and dumping it pushed the machine
past the OOM killer. Postgres restarted and recovered on its own, the application stayed up
and no data was lost, but the machine was already living close enough to the edge that a
routine backup pushed it over.

The machine is now **1 GB**. The backup then succeeded and the restore verified clean.

Two things follow from this, and they matter more than the backup itself:

- **The database was one memory spike away from being OOM-killed during normal operation.**
  The backup did not cause a fragile situation; it revealed one.
- **Images do not belong in Postgres.** `docs/CLAUDE.md` already says so — *"Logos go to R2,
  never as data URLs in the database"* — and 24 of the 31 stored images are the card-template
  photographs added on 4 August, which made an existing problem three times worse. Moving
  `CardImage` to object storage would shrink the database by 99%, make dumps trivial, and
  remove this failure mode entirely. It is the single highest-value piece of technical debt
  in the project.

---

## Taking a backup

On the database machine:

```sh
fly ssh console --app loyanexa-db
export PGPASSWORD=$OPERATOR_PASSWORD
sh /path/to/backup-db.sh
```

From a laptop, through a tunnel:

```sh
fly proxy 5433:5432 --app loyanexa-db
PGHOST=localhost PGPORT=5433 PGUSER=postgres PGPASSWORD=… sh scripts/backup-db.sh
```

The script dumps, **verifies the dump opens**, uploads offsite if `BACKUP_S3_BUCKET` is set,
and prunes to `KEEP` (default 14). It fails loudly rather than leaving an unreadable file
behind, because a backup nobody has opened is a rumour.

---

## Restoring — the runbook

### Into a scratch database, to check something

Safe. The live database is untouched.

```sh
fly ssh console --app loyanexa-db
export PGPASSWORD=$OPERATOR_PASSWORD
createdb -h localhost -U postgres restore_test
pg_restore -h localhost -U postgres -d restore_test --no-owner --no-privileges backup.dump
psql -h localhost -U postgres -d restore_test -c 'select count(*) from "Pass"'
# when finished:
psql -h localhost -U postgres -d postgres -c 'drop database restore_test'
```

### Over the live database, after losing data

**Destructive.** Everything written since the dump is gone. Stop the application first, or
it will keep writing into a database you are replacing underneath it.

```sh
fly scale count 0 --app loyanexa-new          # stop writes
fly ssh console --app loyanexa-db
export PGPASSWORD=$OPERATOR_PASSWORD
psql -h localhost -U postgres -d postgres -c 'drop database loyanexa_new'
createdb -h localhost -U postgres loyanexa_new
pg_restore -h localhost -U postgres -d loyanexa_new --no-owner --no-privileges backup.dump
fly scale count 1 --app loyanexa-new          # resume
```

Then check the application health endpoint and one real card before telling anyone it is
fixed.

### From a Fly volume snapshot

```sh
fly volumes snapshots list vol_vlyk8q296djoooo4 --app loyanexa-db
fly volumes create pg_data --snapshot-id vs_… --app loyanexa-db --region lhr
```

This creates a **new volume**. Attaching it means recreating the Postgres machine against it.
Do this only if the volume itself is lost — restoring a logical dump is less disruptive in
every other case.

---

## What is still missing

Honest list, in the order it matters:

1. **No offsite copy.** Every backup that exists lives in the same Fly account, in the same
   region, as the database. That is the failure this is supposed to survive. Needs an
   S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS) and its credentials as Fly
   secrets; `backup-db.sh` already uploads once `BACKUP_S3_BUCKET` is set.
2. **Nothing is scheduled.** The script has to be run by hand today. Once there is somewhere
   offsite to put the output, this should be a nightly job.
3. **Restores are tested manually.** The 5 August test was run by hand and its results are
   recorded here. It should be repeated after any schema change large enough to worry about.
4. **`CardImage` still lives in Postgres.** See above. This is the fix that makes the other
   three easy.
