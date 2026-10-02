#!/bin/sh
# Usage: /opt/jumpads/restore.sh /opt/jumpads/backups/crm-YYYY-MM-DD_HHMMSS.sqlite.gz
# Replaces the live database with the backup; the current state is backed up first.
set -e
[ -f "$1" ] || { echo "usage: $0 /opt/jumpads/backups/crm-....sqlite.gz" >&2; exit 1; }
/opt/jumpads/backup.sh
docker stop jumpads-crm >/dev/null
gunzip -c "$1" | docker run --rm -i --user root -v jumpads-data:/data jumpads-crm:latest \
  sh -c 'cat > /data/crm.sqlite && rm -f /data/crm.sqlite-wal /data/crm.sqlite-shm && chown node:node /data/crm.sqlite'
docker start jumpads-crm >/dev/null
echo "restored from $1"
