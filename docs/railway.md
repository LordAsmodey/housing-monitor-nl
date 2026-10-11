# Railway

## Целевая конфигурация

Проект `housing-monitor-nl`, окружение `production`:

- Сервис приложения из GitHub `LordAsmodey/housing-monitor-nl`, ветка `main`.
- PostgreSQL и Redis в том же проекте и окружении, с постоянными volumes.
- Dockerfile builder и health-check `/health/live` определены в `railway.json`.
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

Первое развёртывание считается проверенным после успешной сборки, HTTP 200 на публичном `/health/live` и совпадения deployed commit с `main`. Автодеплой дополнительно проверяется следующим push в `main`.

## Текущие ограничения

Health endpoint показывает только состояние HTTP-процесса. Подключение к БД/Redis, миграции и мониторинг источников пока не реализованы. Pre-deploy migrations не включены: в репозитории ещё нет миграций. Локальная тестовая отправка Telegram в группу проверена; настройка Variables для Railway и автоматическая доставка с outbox ещё предстоят. Инструкция: [telegram.md](telegram.md).
