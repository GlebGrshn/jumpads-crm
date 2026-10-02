#!/bin/sh
# Consistent SQLite snapshot while the CRM keeps running (VACUUM INTO); 14 days kept in /opt/jumpads/backups.
# Cron: /etc/cron.d/jumpads-backup runs it daily at 03:15.
set -e
umask 077
name="crm-$(date +%Y-%m-%d_%H%M%S).sqlite"
docker exec jumpads-crm node -e "new (require('node:sqlite').DatabaseSync)(process.env.DB_PATH).exec(\"VACUUM INTO '/app/data/$name'\")" 2>/dev/null
mkdir -p /opt/jumpads/backups
docker cp "jumpads-crm:/app/data/$name" "/opt/jumpads/backups/$name"
docker exec jumpads-crm rm -f "/app/data/$name"
gzip -f "/opt/jumpads/backups/$name"
find /opt/jumpads/backups -name 'crm-*.sqlite.gz' -mtime +14 -delete
echo "$(date -Is) backup /opt/jumpads/backups/$name.gz"
