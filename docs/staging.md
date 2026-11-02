# Platform v2 staging

Проверено 2 ноября 2026. **B03 выполнена частично:** отдельный пассивный API и БД работают; bot/OAuth-конфигурация и полная приёмка изоляции ещё заблокированы. Production не изменялся. B04 (автоматический deployment integration → staging и production release gate) не реализована.

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
| Локальные Prisma/typecheck/build/integration | Заблокированы отсутствующим generated client/engine: загрузка `binaries.prisma.sh` отвергнута сетевой политикой HTTP 403. Удалённая сборка и миграция не заменяют integration suite |
| Прямые публичные HTTP/admin-404 probes | Не выполнены из-за сетевой политики среды; отсутствие admin API подтверждено кодом и runtime route mapping, а не наблюдаемым HTTP 404 |
| Frontend tests | SKIPPED: UI не менялся |

Мок-тесты мигратора проверяют отказ и изоляцию процесса, а не применение SQL. Code review одобрен после одного исправления порядка загрузки legacy-инструментации; новые тесты прошли отдельное review.

## Что осталось для B03

Файл тестовых Telegram/Google credentials находится на домашнем MacBook пользователя и в текущей среде недоступен. В Railway эти credentials не настроены; их изоляция от production и выделенная конфигурация с запланированными callback/webhook URL не проверены. Не добавлять их вслепую в текущий сервис: пассивный guard намеренно откажет в запуске.

Следующий шаг — безопасно предоставить выделенную тестовую конфигурацию через secret store и вне пассивного API проверить принадлежность credentials отдельным bot/OAuth-приложениям, отсутствие production credentials и запланированные staging callback/webhook URL. Текущий guard сохраняет запрет интеграций в пассивном API. Реализация входа, Telegram linking и webhook относится к последующим A/I/T-задачам и не требуется для проверки выделенной конфигурации B03. Затем выполнить оставшиеся HTTP/изоляционные проверки и integration suite в разрешённой среде; после закрытия критериев B03 переходить к зависимой B04. [Общий план](plans/multi-user-platform-v2.md) остаётся источником порядка задач.
