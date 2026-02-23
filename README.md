# AISDK (my-ai-chat)

Next.js (App Router) чат-приложение с AI SDK и “правой панелью документа”: генерация/редактирование Markdown-документа потоково, работа с вложениями (PDF/Office/изображения), сохранение диалогов.

## Быстрый старт

1) Установить зависимости:

```bash
npm install
```

2) Задать переменные окружения (минимум):

- `OPENROUTER_API_KEY`
- `SURREALDB`

1) Запуск:

```bash
npm run dev
```

Открыть http://localhost:3000

## Совместная работа с GitHub (VS Code)

### 1. Установка проекта на ПК

```bash
git clone https://github.com/Namelomax/Hackaton.git
cd Hackaton
npm install
cp .env.example .env.local # если файла нет — создать .env.local вручную
npm run dev
```

Если `cp .env.example .env.local` не сработал, просто создайте `.env.local` и добавьте нужные переменные окружения.

### 2. Базовый цикл работы в ветках

```bash
git checkout main
git pull origin main
git checkout -b feature/my-change
```

После этого делайте изменения в VS Code, проверяйте их и коммитьте в своей ветке.

### 3. Как сравнивать, что изменения работают

1. Локально проверить приложение: `npm run dev` и пройти сценарии вручную в браузере.
2. Проверить стиль/ошибки: `npm run lint`.
3. Проверить тесты: `npm test`.
4. Посмотреть, что изменилось по файлам:

```bash
git status
git diff
```

5. Если нужно сравнить ветку с `main`:

```bash
git fetch origin
git diff origin/main...HEAD
```

### 4. Как отправлять изменения в GitHub

```bash
git add .
git commit -m "feat: короткое описание"
git push -u origin feature/my-change
```

Дальше на GitHub:
1. Открыть Pull Request из вашей ветки в `main`.
2. Добавить описание: что изменено, как проверить, какие есть ограничения.
3. Попросить ревью у второго разработчика.
4. После апрува — merge.

### 5. Как подтягивать изменения коллеги

Если вы работаете в своей ветке и хотите подтянуть свежий `main`:

```bash
git fetch origin
git rebase origin/main
# или git merge origin/main
```

Если появились конфликты:
1. VS Code подсветит конфликтующие места.
2. Выберите нужный вариант (`Accept Current`, `Accept Incoming`, `Accept Both`) или отредактируйте вручную.
3. Завершите процесс:

```bash
git add .
git rebase --continue # если был rebase
# или git commit, если был merge
```

### 6. Минимальные правила для работы вдвоём

- Не коммитьте напрямую в `main`.
- Один PR = одна задача.
- Пишите осмысленные сообщения коммитов (`feat:`, `fix:`, `refactor:`).
- Перед push запускайте `npm run lint` и (желательно) `npm test`.
- Все секреты храните только в `.env.local`, не в репозитории.

### 2026-01-06 — Download update
- Улучшения скачивания: документ в `.md` и выгрузка всех использованных вложений одним архивом (ZIP).
- В панели вложений: компактный вид “иконки” + hover действия.

### 2026-01-03 — save fix
- Правки сохранения.

### 2026-01-02 — Last update / Edit update
- Улучшения режима редактирования документа.

### 2025-12-30 — Xiomi test (9820105)
- Эксперименты с моделью.

### 2025-12-26 — Classifier fix and edit feature added
- Починка классификатора маршрутизации.
- Добавлен функционал редактирования.

### 2025-12-23 — Files update / Promt updates
- Улучшения промптов/шагов промпта.
- Обновления обработки/отображения файлов.

### 2025-12-19 — behavior fix and doc save
- Исправления поведения + сохранения документа.

### 2025-12-12 — Files Visual and Pdf support
