#!/bin/sh
# scripts/backup-db.sh — a logical backup of the LoyaNexa database.
#
# Run it ON the database machine:
#     fly ssh console --app loyanexa-db
#     sh /path/to/backup-db.sh
#
# or from a laptop with the tunnel open:
#     fly proxy 5433:5432 --app loyanexa-db
#     PGHOST=localhost PGPORT=5433 PGUSER=postgres PGPASSWORD=... sh scripts/backup-db.sh
#
# WHY THIS EXISTS ALONGSIDE FLY'S VOLUME SNAPSHOTS
#
# Fly already snapshots the volume daily and keeps them 5 days. That is a real
# safety net and it is better than nothing, but it is not a backup strategy:
#
#   - 5 days only. Corruption noticed on the sixth day is unrecoverable.
#   - Same provider, same region. It does not survive losing the account.
#   - Block-level, not logical. It restores a whole volume, not "the Card
#     table as it was on Tuesday", and it cannot be restored into a different
#     Postgres version or a different host.
#
# A pg_dump is portable, greppable, and restorable anywhere. Keep both.
#
# MEMORY. Dumping this database once OOM-killed Postgres outright, because the
# machine had 256MB and CardImage holds ~24MB of image blobs — 99% of the
# database. The machine is now 1GB. If images ever move out of Postgres and
# into object storage (docs/CLAUDE.md says they should), this gets far
# cheaper; until then, do not run this on a machine under memory pressure.

set -eu

PGHOST="${PGHOST:-localhost}"
PGUSER="${PGUSER:-postgres}"
DB="${DB:-loyanexa_new}"
OUT_DIR="${OUT_DIR:-/data/backups}"
KEEP="${KEEP:-14}"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$OUT_DIR/${DB}-${STAMP}.dump"

mkdir -p "$OUT_DIR"

echo "[backup] dumping $DB -> $FILE"
pg_dump -h "$PGHOST" -U "$PGUSER" -d "$DB" -Fc -f "$FILE"

# A dump that cannot be listed cannot be restored. Verifying costs a second
# and turns "we have backups" into "we have backups that open".
if ! pg_restore -l "$FILE" > /dev/null 2>&1; then
  echo "[backup] FAILED: $FILE is not a readable dump" >&2
  rm -f "$FILE"
  exit 1
fi
echo "[backup] verified, $(du -h "$FILE" | cut -f1)"

# Offsite. Without this the backup shares a failure domain with the thing it
# is backing up, which is the failure mode it exists to survive.
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  echo "[backup] uploading to s3://$BACKUP_S3_BUCKET/"
  aws s3 cp "$FILE" "s3://$BACKUP_S3_BUCKET/$(basename "$FILE")" \
    ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"}
else
  echo "[backup] WARNING: BACKUP_S3_BUCKET unset — this copy is on the same"
  echo "[backup]          volume as the database it came from, so it does not"
  echo "[backup]          survive losing that volume. See docs/BACKUPS.md."
fi

# Local retention.
COUNT=$(ls -1 "$OUT_DIR"/${DB}-*.dump 2>/dev/null | wc -l | tr -d ' ')
if [ "$COUNT" -gt "$KEEP" ]; then
  ls -1t "$OUT_DIR"/${DB}-*.dump | tail -n +$((KEEP + 1)) | while read -r old; do
    echo "[backup] pruning $(basename "$old")"
    rm -f "$old"
  done
fi

echo "[backup] done"
