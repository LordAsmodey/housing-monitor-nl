# Housing Monitor NL

Мониторинг долгосрочной аренды в Нидерландах. Первый регион — Groningen и окрестности.

Источник требований: [архитектура и план реализации, v1.0 от 11.10.2026](https://app.notion.com/p/Housing-Monitor-NL-AI-3f6d10c6e6ab81fe8b06e6eebb9c9455).

## Текущее состояние

Инициализация проекта: NestJS + TypeScript, проверка конфигурации, `GET /health/live`, начальная Prisma-схема, PostgreSQL/Redis в Docker Compose, тесты конфигурации и CI. Это ещё не рабочий мониторинг: приложение пока не подключает БД/Redis и не собирает объявления, не вызывает LLM и не отправляет Telegram-сообщения. Health endpoint проверяет только работу HTTP-процесса.

## Локальный запуск

Нужны Node.js 24 LTS, npm и Docker Compose v2.

```sh
cp .env.example .env
npm ci
docker compose up -d postgres redis
npm run db:generate
# Создать локальную БД по начальной схеме (миграции пока не зафиксированы):
npm run db:migrate -- --name init
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
