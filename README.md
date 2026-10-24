# Housing Monitor NL

Мониторинг долгосрочной аренды в Нидерландах с доставкой новых подходящих объявлений в Telegram.

[Индекс документации и кода](docs/index.md) · [Требования в Notion](https://app.notion.com/p/3f6d10c6e6ab81fe8b06e6eebb9c9455)

## Устройство

NestJS + TypeScript, PostgreSQL/Prisma, детерминированные HTTP/JSON и браузерные адаптеры,
React-админка, transactional Telegram outbox. Scheduler по умолчанию запускает проверки
каждые 900 секунд; PostgreSQL lease предотвращает overlap. LLM не входит в MVP.

Фильтры задаются отдельно для каждого источника. Funda использует поиск «за сегодня»
(`publication_date=1`); старый Source ID с `3d` сохранён для baseline и дедупликации.
Состав источников и пути к их реализации — в [индексе](docs/index.md#источники),
изменяемые настройки — в админке. Датированный smoke не является текущим статусом production.

## Локальный запуск

Нужны Node.js 24, npm и Docker Compose v2.

```sh
cp .env.example .env
npm ci
npm ci --prefix admin
docker compose up -d postgres redis
npm run db:generate
npm run db:deploy
npm run build:all
node --env-file=.env dist/main.js
curl http://localhost:3000/health/live
```

Prisma читает `.env` автоматически. Для watch-режима backend:

```sh
node --env-file=.env --import tsx --watch src/main.ts
```

Админка — `/admin/`; для frontend-разработки запустите `npm run admin:dev`.
Нужны серверные `ADMIN_LOGIN` и `ADMIN_PASSWORD`: [инструкция](docs/admin.md).
Настройка и диагностика Telegram — [telegram.md](docs/telegram.md) и [outbox.md](docs/outbox.md).

Контейнер приложения: `docker compose --profile app up --build -d`.
Production-образ: `docker build -t housing-monitor-nl .`.
Development-пароли Compose не предназначены для production. Зарезервированные символы
пароля в DATABASE_URL должны быть URL-кодированы. При собственном proxy CA настройте
доверие сертификату в build-процессе с сохранением проверки TLS.

## Проверки

```sh
npm run typecheck
npm test
npm run build:all
npm run db:validate
# Только отдельная тестовая PostgreSQL с применёнными миграциями:
DATABASE_URL=postgresql://housing:test@localhost:55432/housing npm run test:integration
```

Для `db:validate` нужен DATABASE_URL, соединение с БД не требуется.
Проверки конкретного адаптера и read-only live smoke указаны в его runbook.
Интеграционные тесты не подключать к production.

## Общие контракты

Только чтение сайтов; обязательные CAPTCHA/MFA требуют человека. Ошибка чтения и
частичный обход не считаются успешным нулём. Первая полная загрузка и применение новой
версии фильтров создают тихий baseline. Объявления и outbox сохраняются транзакционно;
подтверждённые доставки защищены дедупликацией, неоднозначные имеют статус UNCERTAIN.
Сессии источников изолированы и зашифрованы; секреты и recovery-ссылки не публикуются.

Подробные требования и границы — в профильных страницах [индекса](docs/index.md).
[План](docs/roadmap.md) · [Railway](docs/railway.md) · [Sentry](docs/sentry.md)
