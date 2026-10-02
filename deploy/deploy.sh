#!/bin/sh
# Rebuild the CRM image from /opt/jumpads and recreate the container; data stays in the jumpads-data volume.
# Run after changing code or .env: Docker reads .env only when the container is created.
set -e
cd /opt/jumpads
docker build -q -t jumpads-crm:latest .
docker rm -f jumpads-crm >/dev/null 2>&1 || true
# Host network: this server reaches Telegram only over IPv6, which the default Docker bridge lacks.
# The CRM still listens on 127.0.0.1 only; Caddy is the public entry.
docker run -d --name jumpads-crm --restart always --network host --log-opt max-size=10m --log-opt max-file=3 -v jumpads-data:/app/data --env-file /opt/jumpads/.env \
  -e HOST=127.0.0.1 -e PORT=3000 -e NODE_OPTIONS=--dns-result-order=ipv6first \
  -e DB_PATH=/app/data/crm.sqlite -e NODE_ENV=production -e TRUST_PROXY=true \
  -e TEST_ROLE_SELECTION=true -e PUBLIC_ENTRY_URL= -e APP_PUBLIC_URL=https://lushik.online -e BOT_TIMEZONE=Europe/Moscow \
  jumpads-crm:latest >/dev/null
for i in $(seq 1 30); do curl -sf http://127.0.0.1:3000/health >/dev/null && { echo "CRM is up"; exit 0; }; sleep 1; done
echo "CRM did not answer /health; see: docker logs jumpads-crm" >&2; exit 1
