#!/bin/bash
# Обновление и перезапуск Протоколера — по образцу anonstart.sh.
# Установка:  cp ~/protokoler/deploy/protokoler-start.sh ~/protostart.sh && chmod +x ~/protostart.sh
# Запуск:     ~/protostart.sh
set -e
export PATH=~/node-v22.20.0-linux-x64/bin:$PATH

cd ~/protokoler

# Запоминаем lock ДО git pull, чтобы понять, менялись ли зависимости.
LOCK_BEFORE=$(md5sum package-lock.json 2>/dev/null | cut -d' ' -f1 || echo none)
git pull
LOCK_AFTER=$(md5sum package-lock.json 2>/dev/null | cut -d' ' -f1 || echo none)

# npm ci переустанавливает node_modules с нуля (долго) — делаем только когда
# зависимости реально изменились или их ещё нет.
if [ "$LOCK_BEFORE" != "$LOCK_AFTER" ] || [ ! -d node_modules ]; then
  echo "→ зависимости изменились, npm ci"
  npm ci
fi

npm run build
systemctl --user restart protokoler

sleep 2
systemctl --user is-active --quiet protokoler \
  && echo "✓ protokoler запущен: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8012/) на :8012" \
  || { echo "✗ не поднялся — логи: journalctl --user -u protokoler -n 50 --no-pager"; exit 1; }
