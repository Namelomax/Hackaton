#!/bin/bash
# Обновление и перезапуск Протоколера (по образцу anonstart.sh).
set -e
NODE=~/node-v22.20.0-linux-x64/bin
cd ~/protokoler && git pull
"$NODE/npm" ci
"$NODE/npm" run build
systemctl --user restart protokoler
echo "Готово. Статус: systemctl --user status protokoler"
