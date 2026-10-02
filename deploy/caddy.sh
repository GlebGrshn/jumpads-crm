#!/bin/sh
# (Re)create the Caddy container: HTTPS for lushik.online, certificates kept in the caddy-data volume.
set -e
docker rm -f caddy >/dev/null 2>&1 || true
docker run -d --name caddy --restart always --network host --log-opt max-size=10m --log-opt max-file=3 \
  -v /opt/jumpads/Caddyfile:/etc/caddy/Caddyfile:ro -v caddy-data:/data -v caddy-config:/config caddy:2-alpine >/dev/null
echo "Caddy started"
