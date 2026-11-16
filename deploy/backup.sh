#!/bin/sh
# Nightly backup: database dump plus media files, 14 days kept.
# Cron (as root):  15 2 * * *  /path/to/deploy/backup.sh >> /var/log/shuttlecircle-backup.log 2>&1
# Restore:  docker compose exec -T db pg_restore -U shuttlecircle -d shuttlecircle --clean < db-<stamp>.dump
set -eu
cd "$(dirname "$0")"
DEST=${BACKUP_DIR:-/var/backups/shuttlecircle}
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$DEST"

docker compose exec -T db pg_dump -U shuttlecircle -Fc shuttlecircle > "$DEST/db-$STAMP.dump.part"
mv "$DEST/db-$STAMP.dump.part" "$DEST/db-$STAMP.dump"
docker compose exec -T api tar czf - -C /media . > "$DEST/media-$STAMP.tgz"

find "$DEST" -name 'db-*.dump' -mtime +14 -delete
find "$DEST" -name 'media-*.tgz' -mtime +14 -delete
echo "$STAMP backup ok: $(du -sh "$DEST" | cut -f1) in $DEST"
# Offsite copy: add an rclone or rsync line here once a target is chosen.
