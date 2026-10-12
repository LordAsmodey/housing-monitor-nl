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
Текущий браузерный мониторинг Funda и Huurwoningen и HTTP-мониторинг Woldring подключены
к production scheduler; инструкции приведены ниже. Длительная стабильная эксплуатация ещё
не подтверждена. BullMQ не подключён. LLM исключён из обязательного MVP и отложен
до доказанной необходимости по решению пользователя от 12.10.2026.

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

- Проверка каждые 900 секунд по умолчанию; мониторинг выполняют HTTP/Playwright адаптеры без LLM.
- Подключение источников и исправление адаптеров выполняет разработчик; при сбоях используются ограниченные повторы, диагностика и ручное восстановление.
- Адаптеры и сценарии версионируются и проверяются перед публикацией. AI onboarding и self-healing отложены в дальний backlog без срока.
- Неудача чтения не равна нулю объявлений; последняя попытка и последний успех учитываются отдельно.
- Baseline первого запуска без массовых уведомлений; запись объявления и outbox в одной транзакции.
- Источники только для чтения; обязательные CAPTCHA/MFA переводят источник в blocked.
- Browser state хранится отдельно и зашифрованно; в БД только ссылки на него и секреты.
- Доменные allowlists, SSRF-защита, отсутствие overlap, rate limits, cooldown и бюджет восстановления обязательны до включения реальных источников.

Детали и следующие шаги: [docs/roadmap.md](docs/roadmap.md).

## Huurwoningen

Второй браузерный источник: Groningen +25 км, до €1500, свежесть `since=1`, доступность для заселения в течение трёх месяцев и исключение обмена по пользовательской ссылке.
Для включения задаются `HUURWONINGEN_BROWSER_ORIGIN` и `HUURWONINGEN_BROWSER_TOKEN`.
Отдельные сессия и baseline, полная пагинация, существующий Telegram outbox и CAPTCHA recovery:
[инструкция](docs/huurwoningen.md).

## Woldring Verhuur

Квартиры и студии подключаются автоматически к расписанию 15 минут и существующему Telegram outbox.
Первый запуск сохраняет отдельный baseline; затем приходят новые доступные объекты и переходы
из недоступных в доступные, без повторных уведомлений. Нет ограничений цены, площади и даты публикации.
Аренда, servicekosten, дата заселения и пометка о закрытом приёме заявок: [инструкция](docs/woldring.md).

## Vesteda

Подготовлен поиск Groningen +20 км, аренда €500–1500 по пользовательской ссылке.
Пользователь подтвердил письменное разрешение Vesteda; мониторинг включён по умолчанию
после развёртывания. `VESTEDA_MONITORING_ENABLED=false` приостанавливает источник.
Публичный JSON API, отдельный baseline,
уведомления о новых доступных квартирах и повторной доступности:
[инструкция](docs/vesteda.md). Первый запуск не рассылает существующие объявления.

## Telegram

Подготовлены команды подключения группы: `npm run telegram:check`,
`npm run telegram:chats`, `npm run telegram:test`.
Порядок настройки секретов и получения ID: [docs/telegram.md](docs/telegram.md).
Worker и outbox реализованы; включение и диагностика: [docs/outbox.md](docs/outbox.md).

## Railway

Целевая площадка — Railway. Конфигурация сборки и health-check: `railway.json`. Настройка GitHub-autodeploy и переменных описана в [docs/railway.md](docs/railway.md).

## Sentry

Ошибки источников, запуска и доставки могут отправляться в Sentry через `SENTRY_DSN`.
Настройка, проверка доставки и ограничения Crons: [docs/sentry.md](docs/sentry.md).
