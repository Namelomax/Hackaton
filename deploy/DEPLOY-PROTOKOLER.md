# Деплой Протоколера рядом с анонимизатором (сервер yakov@330801)

Цель: Next.js-протоколер на сервере, доступен по `https://protocol.cpcore.ru`,
анонимизация — через локальный python-сервер (тонкий клиент, `/jobs/anonymize`).

## 0. Перевыпусти ключи (СРОЧНО)

`.env` анонимизатора с живыми ключами (OpenRouter, Google, SerpAPI, SurrealDB,
токен анонимизатора) утёк. Отзови и пересоздай ВСЕ ключи до запуска.

## 1. Порт — 3000 (НЕ 8011!)

8011 занят python-бэкендом анонимизатора (`curl -s https://protocol.cpcore.ru/`
сейчас отдаёт его health-JSON, а не протоколер). У протоколера свободен 3000.

```bash
ss -ltnp | grep -E ':(3000|8000|8010|8011)'   # 3000 должен быть свободен
```

## 2. nginx protocol.cpcore.ru → 127.0.0.1:3000

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;          # было 8011 — ИСПРАВИТЬ
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
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/    # → 200
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
