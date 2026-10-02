#!/bin/sh
# Every 5 minutes (cron /etc/cron.d/jumpads-monitor): checks the public site and both bots.
# A problem lasting two checks in a row is reported to CRM administrators with a bound Telegram, recovery too.
set -u
dir=/opt/jumpads
token=$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$dir/.env" | tr -d '\r')
problems=""
health=$(curl -s -m 20 https://lushik.online/health || true)
case "$health" in
  *'"ok":true'*)
    for bot in team client; do
      case "$health" in *"\"$bot\":\"connected\""*|*"\"$bot\":\"disabled\""*) ;; *) problems="$problems
• бот $bot не подключён к Telegram";; esac
    done;;
  *) problems="$problems
• сайт https://lushik.online не отвечает";;
esac
# Admin chats are re-read while the CRM works, so alerts still reach them when it does not.
ids=$(docker exec jumpads-crm node -e "const db=new (require('node:sqlite').DatabaseSync)(process.env.DB_PATH,{readOnly:true});console.log(db.prepare(\"SELECT telegram_id FROM users WHERE role='admin' AND telegram_id IS NOT NULL\").all().map(r=>r.telegram_id).join(' '))" 2>/dev/null || true)
[ -n "$ids" ] && echo "$ids" > "$dir/alert-chats"
send() { for id in $(cat "$dir/alert-chats" 2>/dev/null); do curl -s -m 20 -o /dev/null "https://api.telegram.org/bot$token/sendMessage" --data-urlencode "chat_id=$id" --data-urlencode "text=$1"; done; }
state=$(cat "$dir/monitor.state" 2>/dev/null || echo ok)
if [ -n "$problems" ]; then
  count=$(( $(cat "$dir/monitor.count" 2>/dev/null || echo 0) + 1 )); echo "$count" > "$dir/monitor.count"
  if [ "$state" = ok ] && [ "$count" -ge 2 ]; then send "⚠️ Jumpads CRM: проблема$problems"; echo fail > "$dir/monitor.state"; fi
  echo "$(date -Is) problem:$(echo "$problems" | tr '\n' ' ')"
else
  echo 0 > "$dir/monitor.count"
  if [ "$state" = fail ]; then send "✅ Jumpads CRM снова работает"; echo ok > "$dir/monitor.state"; fi
fi
