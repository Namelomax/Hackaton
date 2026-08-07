# Деплой Протоколера рядом с анонимизатором (сервер yakov@330801)

Цель: Next.js-протоколер на сервере, доступен по `https://protocol.cpcore.ru`,
анонимизация — через локальный python-сервер (тонкий клиент, `/jobs/anonymize`).

## 0. Перевыпусти ключи (СРОЧНО)

`.env` анонимизатора с живыми ключами (OpenRouter, Google, SerpAPI, SurrealDB,
токен анонимизатора) утёк. Отзови и пересоздай ВСЕ ключи до запуска.

## 1. Порт — 8012 (НЕ 8011 и НЕ 3000!)

Реальная картина портов на сервере (проверено `ss -ltnp`):

| Порт | Что | Чей |
|---|---|---|
| 8000 | — | чужой процесс |
| 3000 | — | **чужой процесс** (не занимать!) |
| 8010 | `next-server` — веб-UI анонимизатора | yakov |
| 8011 | `python` — бэкенд анонимизатора | yakov |
| **8012** | **Протоколер (Next.js)** | ← ставим сюда |

`protocol.cpcore.ru` сейчас проксирует на **8011**, т.е. отдаёт JSON питон-анонимизатора,
а не протоколер. Проверить: `curl -s https://protocol.cpcore.ru/ | head -c 200`.

Убедиться, что 8012 свободен:
```bash
for p in 8012 8020 3001 4000 9000; do ss -ltn "sport = :$p" | grep -q LISTEN && echo "$p BUSY" || echo "$p free"; done
```
Если 8012 занят — возьми свободный из списка и поменяй в трёх местах: `PORT` в `.env`,
`-p`/`Environment=PORT` в `protokoler.user.service`, `proxy_pass` в nginx.

## 2. nginx protocol.cpcore.ru → 127.0.0.1:8012 (нужен sudo — просить владельца)

```nginx
location / {
    proxy_pass http://127.0.0.1:8012;          # было 8011 (анонимизатор) — ИСПРАВИТЬ
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection '';
    proxy_buffering off;         # ОБЯЗАТЕЛЬНО: протокол стримится в правую панель по SSE
    proxy_read_timeout 320s;
    client_max_body_size 50m;
}
```
```bash
sudo nginx -t && sudo systemctl reload nginx   # -t обязателен: рядом arena/anon.cpcore.ru
```

## 3. Код + сборка

```bash
cd ~ && git clone <repo-url> protokoler   # или git pull
cd protokoler
~/node-v22.20.0-linux-x64/bin/npm ci
cp deploy/protokoler.env.example .env
nano .env                                 # перевыпущенные ключи; ANONYMIZER_URL=http://127.0.0.1:8011
~/node-v22.20.0-linux-x64/bin/npm run build
```

## 4. SurrealDB (если поднимаешь через docker-compose протоколера)

Порт 8000 на хосте занят чужим uvicorn → задай в `.env` ДО первого `up`:
```
SURREAL_PORT=127.0.0.1:8003
```
Проверь, та же ли база, что у Vercel-прода (иначе пользователи/чаты не совпадут):
```bash
curl -s https://protocol.cpcore.ru/api/health/db | jq .
curl -s https://<vercel-домен>/api/health/db | jq .   # сравни url/namespace/database/userCount
```

## 5. systemd + запуск

```bash
mkdir -p ~/.config/systemd/user
cp deploy/protokoler.user.service ~/.config/systemd/user/protokoler.service
systemctl --user daemon-reload
systemctl --user enable --now protokoler
loginctl enable-linger yakov
systemctl --user status protokoler
```

## 6. Проверка

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8012/    # → 200
curl -s https://protocol.cpcore.ru/ | head -c 120                  # уже НЕ health-JSON анонимизатора
```
Открой `https://protocol.cpcore.ru`, прогони документ в режиме «Облако +
анонимизация». В логах python-сервера должен быть `POST /jobs/anonymize`, в
готовом протоколе — НЕТ `[PERSON_N]`.

## 7. Обновление

`deploy/protokoler-start.sh` (git pull → npm ci → build → restart).

## Что изменилось в коде (для контекста)

- Анонимизация — тонкий клиент к python-серверу (`/jobs/anonymize` + опрос из
  браузера). Прямой TS-GLiNER (`GLINER_URL`, chunking/spans/…) удалён. Не задавай
  `GLINER_URL`.
- Возвращён фикс изоляции чатов (`assertConversationOwnership`): диалог одного
  пользователя не попадёт в чужой (в задеплоенной ветке его не было).
