# Railway

## Целевая конфигурация

Проект `housing-monitor-nl`, окружение `production`:

- Сервис приложения из GitHub `LordAsmodey/housing-monitor-nl`, ветка `main`.
- PostgreSQL и Redis в том же проекте и окружении, с постоянными volumes.
- Dockerfile builder, pre-deploy `npm run db:deploy` и health-check `/health/ready` определены в `railway.json`.
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

В настройках Source сервиса подключить GitHub-репозиторий, выбрать `main`, включить автоматическое развёртывание. У Railway GitHub App должен быть доступ к этому репозиторию. Включить **Wait for CI**, чтобы приложение разворачивалось после успешного workflow `CI`. Сам `railway.json` не подключает репозиторий и не включает автодеплой: это настройки сервиса Railway.

Первое развёртывание считается проверенным после успешной сборки, HTTP 200 на публичном `/health/ready` и совпадения deployed commit с `main`. Автодеплой дополнительно проверяется следующим push в `main`.

Wait for CI подтверждён через Railway describe-service: source.checkSuites=true.
Telegram-переменные уже присутствуют; worker требует TELEGRAM_DELIVERY_ENABLED=true.

## Текущие ограничения

`/health/live` проверяет HTTP-процесс; `/health/ready` проверяет доступность БД и таблицы outbox.
Начальная миграция зафиксирована, Railway применяет её перед запуском новой версии.
Новая миграция рассчитана на пустую БД. Если таблицы уже создавали через db push,
сначала проверьте соответствие схемы и выполните Prisma migration baseline вручную.
Redis, мониторинг источников и LLM ещё не подключены.
Включение Telegram и диагностика: [outbox.md](outbox.md).
