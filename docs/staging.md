# Platform v2 staging

Проверено 2 ноября 2026. **B03 завершена:** отдельный пассивный API и БД работают; выделенная тестовая конфигурация подготовлена, HTTP-изоляция и локальные проверки подтверждены. OAuth-вход и Telegram webhook ещё не реализованы и принимаются в I01/T02/O06. Production не изменялся. B04 (автоматический deployment integration → staging и production release gate) не реализована.

## Ресурсы и выпущенный кандидат

| Ресурс | Значение |
|---|---|
| Railway project | `housing-monitor-nl-v2-staging` — `b84d6133-2fc7-4087-92ad-4e6c96b77f7a` |
| Environment | `staging` — `666d7b8d-3b4b-4f58-abfe-b6fb27b4964c` |
| API service | `74c2f21f-cb7f-40bd-b6ab-e29233472f60` |
| API URL | <https://api-staging-887b.up.railway.app> |
| PostgreSQL service | `6be222a4-4c78-4d08-853a-a7d4c3cd599b` |
| DB volume | `46a2b7c0-7488-4132-8c16-83b45c4cc57c`, 500 MB, `/var/lib/postgresql/data` |
| DB target | `postgres.railway.internal:5432`; database/user `housing_v2_staging` |
| Deployed SHA | `9741d2e37377b20626304e725bf261114daaf113` |
| API deployment | `d9f7f404-4bc7-4fec-ad2a-d3a5aa508d76`, `SUCCESS` в `2026-11-02T07:02:29.492Z` |

Созданы новые ресурсы и пароль БД; production variables, данные и browser state не копировались. Пароль хранится только в Railway Variables. Публичный endpoint БД не создавался; browser services отсутствуют. Source привязан к точному SHA рабочей ветки `codex/b03-v2-staging`: последующие push не запускают deployment. Commit `db512b6` меняет только типы теста и в работающий образ не входит. Целевая base task PR — `codex/platform-v2`.

## Запуск и миграции

Пример имён переменных — [`.env.staging.example`](../.env.staging.example). В Railway заданы `DEPLOYMENT_MODE=staging`, `COLLECTION_ENABLED=false`, `TELEGRAM_DELIVERY_ENABLED=false`, `TELEGRAM_COMMANDS_ENABLED=false`, `NODE_ENV=production`, `PORT=3000` и `DATABASE_URL` через приватную ссылку на Postgres. Идентификаторы Railway предоставляет платформа.

[`staging-isolation.ts`](../src/config/staging-isolation.ts) проверяет фиксированные project/environment/service IDs и точные host/port/database/user БД до импорта приложения или запуска Prisma. Подмена цели через query-параметры отвергается. Bot/OAuth, Redis, Sentry и browser credentials в этом пассивном режиме запрещены. Ошибки не выводят значения секретов.

| Настройка API | Команда / путь |
|---|---|
| Build | Корневой `Dockerfile` |
| Pre-deploy | `npm run db:deploy:staging` |
| Start | `node dist/main.js` |
| Health check | `/health/ready`, timeout 120 секунд |

Мигратор запускается из собранного TypeScript (`dist/database/staging-migrate.js`), проверяет цель и копирует схему/миграции во временную папку без `.env`. Не заменять его legacy-командой `npm run db:deploy` и не загружать production `.env`. Для повторного выпуска сначала проверить новый точный SHA и readback целевых IDs; после запуска дождаться terminal `SUCCESS`, сообщения `Staging migrations applied to the dedicated database` и успешного `/health/ready`.

Пассивный [`StagingModule`](../src/staging.module.ts) содержит только `HealthController` и `PrismaService`: providers сборщиков, admin API, sender и Telegram polling не создаются. `/health/live` проверяет процесс, `/health/ready` — БД и таблицу outbox. Это не пользовательское приложение v2 и не полноценная модель runtime roles A06.

## Доказательства и ограничения

| Проверка | Результат |
|---|---|
| Unit suite | 256/256 passed, exit 0 |
| Финальные environment + staging tests на `db512b6` | 20/20 passed, exit 0; отдельная strict-проверка типов нового теста — exit 0 |
| Отрицательные guard/migration tests | Неверные IDs/DB/flags отвергнуты; отказ до filesystem/child process; ошибки и вывод дочернего процесса не раскрывают секреты |
| Реальный bootstrap с неверной целью | Exit 1 до Nest/Prisma/telemetry initialization |
| Railway Docker build | `npm ci`, `db:generate`, `build:all` прошли на deployed SHA |
| Реальная staging migration/readiness | Guarded pre-deploy успешен; `/health/ready` — 1/1 succeeded; API и Postgres `SUCCESS`, по одной running replica, без issues/pending work |
| Пассивные runtime boundaries | Независимый E2E readback подтвердил только `StagingModule` и маршруты `/health/live`, `/health/ready`; admin/source/delivery modules не инициализировались |
| Локальные Prisma/typecheck/build/integration | `db:generate`, `db:validate`, `typecheck`, `typecheck:ci`, `build:all` — exit 0; 39/39 integration tests — exit 0 на одноразовой PostgreSQL 17, отдельный контейнер/БД `b03_test`, localhost:55450. Все 6 миграций применены с нуля; production/staging БД не использовались |
| Прямые публичные HTTP/admin-404 probes | `/health/live` — 200, `/health/ready` — 200; реальные admin routes `/api/admin/session`, `/api/admin/overview` — 404; запланированный `/api/v1/auth/google/callback` — 404 |
| Frontend tests | SKIPPED: UI не менялся |

Мок-тесты мигратора проверяют отказ и изоляцию процесса, а не применение SQL. Code review одобрен после одного исправления порядка загрузки legacy-инструментации; новые тесты прошли отдельное review.

## Выделенная конфигурация интеграций B03

Повторная проверка 02.11.2026 выполнена на MacBook с доступным `.env.staging.local`. Исходный игнорируемый файл имеет права `0600` и сохраняет localhost callback. Отдельный игнорируемый `.env.staging.integrations.local` (также `0600`) содержит тестовые Google/Telegram credentials, свежий криптографически случайный webhook secret (32 байта) и запланированные URL:

- `GOOGLE_REDIRECT_URI=https://api-staging-887b.up.railway.app/api/v1/auth/google/callback`
- `TELEGRAM_WEBHOOK_URL=https://api-staging-887b.up.railway.app/api/v1/telegram/webhook`

Эти файлы — локальное закрытое хранилище конфигурации, не артефакт Git/CI. Не добавлять их в пассивный Railway API: guard продолжает запрещать integration secrets. При реализации соответствующих runtime roles перенести конфигурацию в закрытые variables выделенного сервиса; не загружать legacy `.env`.

Telegram token и username отличаются от legacy `.env`; read-only `getMe` подтвердил отдельного `Housing_Monitor_NL_V2_bot` и совпадение username. `getWebhookInfo` вернул пустой URL и 0 pending updates. Сообщения не отправлялись, polling не запускался, webhook не менялся. Delivery и commands выключены. Production chat ID отсутствует в тестовой конфигурации.

Google Client ID имеет формат `*.apps.googleusercontent.com`, client secret присутствует; в legacy `.env` Google credentials отсутствуют. Создание отдельного тестового OAuth-клиента, localhost callback и test user ранее подтверждены пользователем ([контекст подготовки](plans/platform-v2-preparation.md)). Это подтверждение происхождения и локальная проверка конфигурации, а не независимый аудит Google Console или успешный OAuth flow. Новый HTTPS callback подготовлен в файле, но его регистрация в Google Console не подтверждена; выполнить её при I01 перед запуском входа. Не использовать для проверки токена endpoint, который создаёт/обновляет webhook или отправляет сообщение.

B03 закрывает базовую конфигурацию и изоляцию пассивного стенда. Регистрация HTTPS callback, активация webhook и OAuth/linking end-to-end остаются в I01/T02/O06; отсутствие этих ещё не реализованных endpoints не выдаётся за приёмку интеграций. B04 — следующий отдельный шаг: автоматический deployment integration → staging и production release gate. [Общий план](plans/multi-user-platform-v2.md) определяет зависимости.
