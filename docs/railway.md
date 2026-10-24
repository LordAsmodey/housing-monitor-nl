# Railway

## Конфигурация сервисов

Проект `housing-monitor-nl`, окружение `production`:

- Сервис приложения из GitHub `LordAsmodey/housing-monitor-nl`, ветка `main`.
- PostgreSQL и Redis в том же проекте и окружении, с постоянными volumes.
- Параметры приложения заданы в Railway: Dockerfile `Dockerfile`, pre-deploy `npm run db:deploy`, health-check `/health/ready`, timeout 120 секунд, ON_FAILURE с 10 повторами.
- Huurwoningen Chrome worker использует тот же репозиторий и `main`, но Dockerfile `Dockerfile.huurwoningen-experiment`, start `node scripts/huurwoningen-patchright-session.cjs`, пустой pre-deploy, health-check `/health`, timeout 180 секунд, ON_FAILURE с 3 повторами, draining 60 секунд. Volume `/data` и переменные сохраняются.
- Funda worker собирается через `Dockerfile.browser`, команда `node scripts/funda-browser-session.cjs`; Pararius Chrome worker — через `Dockerfile.pararius-browser`, команда `node scripts/pararius-browser-session.cjs`. У каждого свой volume `/data`, ключи и health-check `/health`; миграции приложения в worker не запускаются. Проверяйте фактическую конфигурацию перед изменениями.
- Корневой `railway.json` удалён: его Dockerfile приложения переопределял настройку браузера и приводил к `PATCHRIGHT_BROWSER_STARTUP_FAILED`. Новый custom Config File отклоняется Railway API как deprecated. Параметры сервисов сохранены отдельно через API; полная миграция проекта на IaC остаётся отдельной задачей.
- Приложение слушает `0.0.0.0` и автоматически использует `PORT`, предоставленный Railway.

Переменные приложения (имена сервисов должны совпадать с реальными):

```dotenv
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
MONITOR_INTERVAL_SECONDS=900
```

Не переносить development-пароли из Compose. Секреты задаются через Railway Variables, вне Git.

## Автодеплой

В настройках Source каждого сервиса подключить GitHub-репозиторий, выбрать `main`, включить автоматическое развёртывание. У Railway GitHub App должен быть доступ к этому репозиторию. Включить **Wait for CI**, чтобы сервисы разворачивались после успешного workflow `CI`. Source, Dockerfile и health-check задаются отдельно для приложения и браузера.

Первое развёртывание считается проверенным после успешной сборки, HTTP 200 на публичном `/health/ready` и совпадения deployed commit с `main`. Автодеплой дополнительно проверяется следующим push в `main`.

Историческая проверка 14.10.2026 показала source.checkSuites=false у приложения и Chrome worker. Это не live-статус сегодня; при задаче настройки автодеплоя проверяйте фактическое значение.
Telegram-переменные уже присутствуют; worker требует TELEGRAM_DELIVERY_ENABLED=true.

## Текущие ограничения

`/health/live` проверяет HTTP-процесс; `/health/ready` проверяет доступность БД и таблицы outbox.
Миграции версионируются в `prisma/migrations/` и применяются pre-deploy командой приложения.
Для уже существующей БД не повторяйте начальный baseline без проверки истории миграций.
Мониторинг источников подключён. Scheduler/lease и outbox используют PostgreSQL;
BullMQ не подключён, LLM исключён из обязательного MVP.
Включение Telegram и диагностика: [outbox.md](outbox.md).
