# Housing Monitor NL

Мониторинг долгосрочной аренды в Нидерландах. Первый регион — Groningen и окрестности.

## Текущее состояние

NestJS + TypeScript подключает PostgreSQL через Prisma. Зафиксирована начальная миграция,
добавлены `/health/live` и `/health/ready`, сохранение валидированных объявлений с baseline,
дедупликацией и transactional outbox. Worker Telegram включается явно и поддерживает
ограничение частоты, retries, DEAD_LETTER и UNCERTAIN. Добавлен автоматический HTTP-модуль
Funda: Groningen +30 км, аренда до €1500/месяц, публикации за последние 72 часа.
Расписание — 15 минут, блокировки и состояние запусков хранятся в PostgreSQL.
Funda запускается автоматически после старта приложения; инструкция и границы проверки — [docs/funda.md](docs/funda.md).
Live-доступ и разметка Funda в текущем окружении не подтверждены. Redis/BullMQ и LLM пока не подключены.

## Локальный запуск

Нужны Node.js 24 LTS, npm и Docker Compose v2.

```sh
cp .env.example .env
npm ci
docker compose up -d postgres redis
npm run db:generate
npm run db:deploy
npm run build
node --env-file=.env dist/main.js
curl http://localhost:3000/health/live
```

Prisma читает `.env` автоматически. Для watch-режима:

```sh
node --env-file=.env --import tsx --watch src/main.ts
```

Контейнер приложения: `docker compose --profile app up --build -d`.
Compose использует локальные порты и development-пароль из примера. Для VPS нужны отдельные секреты и эксплуатационная настройка. Пароль с зарезервированными символами требуется URL-кодировать в `DATABASE_URL`; в таком случае задайте полный URL приложения отдельно в Compose.

В управляемой облачной среде с proxy CA образ собирается так:

```sh
docker build --secret id=proxy_ca,src="$CODEX_PROXY_CERT" -t housing-monitor-nl .
```

## Проверки

```sh
npm run typecheck
npm test
npm run build
npm run db:validate
# На отдельной тестовой PostgreSQL с применённой миграцией:
DATABASE_URL=postgresql://housing:test@localhost:55432/housing npm run test:integration
```

Для `db:validate` нужен `DATABASE_URL` из `.env` (доступ к серверу БД не нужен).

## Архитектурные правила

- Проверка каждые 900 секунд по умолчанию; здоровый Fast Path работает без LLM.
- AI только для onboarding/recovery; выбор Stagehand/Browser Use/Playwright + LLM после spike.
- Версионированные декларативные сценарии, без исполнения произвольного AI-кода.
- Неудача чтения не равна нулю объявлений; последняя попытка и последний успех учитываются отдельно.
- Baseline первого запуска без массовых уведомлений; запись объявления и outbox в одной транзакции.
- Источники только для чтения; обязательные CAPTCHA/MFA переводят источник в blocked.
- Browser state хранится отдельно и зашифрованно; в БД только ссылки на него и секреты.
- Доменные allowlists, SSRF-защита, отсутствие overlap, rate limits, cooldown и бюджет восстановления обязательны до включения реальных источников.

Детали и следующие шаги: [docs/roadmap.md](docs/roadmap.md).

## Telegram

Подготовлены команды подключения группы: `npm run telegram:check`,
`npm run telegram:chats`, `npm run telegram:test`.
Порядок настройки секретов и получения ID: [docs/telegram.md](docs/telegram.md).
Worker и outbox реализованы; включение и диагностика: [docs/outbox.md](docs/outbox.md).

## Railway

Целевая площадка — Railway. Конфигурация сборки и health-check: `railway.json`. Настройка GitHub-autodeploy и переменных описана в [docs/railway.md](docs/railway.md).
