# Общий контекст агентов Housing Monitor NL

Читай этот файл один раз при начале поручения вместе с корневым `AGENTS.md`.
Дальше открывай только разделы/файлы по задаче. Это навигация и инварианты,
а не копия требований или заявление о готовности v2.

## Требования и состояние ветки

- `docs/index.md` связывает области кода с профильными страницами Notion.
- Явные указания пользователя имеют приоритет. Для изменения поведения нужна
  профильная страница; уже полученный актуальный фрагмент можно передать агенту
  с URL и датой, не заставляя каждого заново читать ту же страницу.
- V2: `docs/plans/multi-user-platform-v2.md`; исходные проверки, согласованные
  дополнения и расхождения с Notion: `docs/plans/platform-v2-preparation.md`.
  Перед задачей читай относящиеся разделы, а не весь backlog.
- Notion архитектуры/админки/backlog получен 31.10.2026 в версиях от 23.10.2026:
  там ещё v1 и multi-user в backlog. Подтверждённые пользователем решения v2
  заменяют соответствующие ограничения v1; предложения плана не становятся
  требованиями автоматически. A01 согласует профильные страницы до реализации
  новых контрактов. Недоступность Notion/конфликт сообщай явно.
- На исходной integration-ветке подготовка B01 уже влита, новые auth/searches/
  matching и пользовательский frontend ещё не реализованы. Проверяй текущий
  checkout: этот снимок не должен мешать дальнейшему развитию ветки.

## Стек: действующий и целевой

| Область | Действующий код | Направление v2 |
|---|---|---|
| Runtime | Node.js 24 для CI/разработки; engines `>=22 <25`, npm | Сверять package/lockfiles, Docker и CI при изменении toolchain |
| Backend | NestJS 11, TypeScript 5.9, Zod 4, Prisma 6, PostgreSQL | Те же базовые технологии, явные роли процессов |
| Frontend | React 19.2 + Vite 7 в `admin/`; CSS, `admin/src/api.ts` | Пользовательский `web/`, `/app/`, API `/api/v1/`; отдельный admin |
| Сбор | `src/sources/`, `scripts/`, HTTP и отдельные browser workers | Общий каталог, collection scope отдельно от персональных фильтров |
| Очереди | PostgreSQL scheduler/lease и transactional outbox | Durable jobs, fencing/heartbeat, bounded batches; Redis/BullMQ не внедрены |
| Доставка | `src/delivery/`, Telegram Bot API, legacy env-chat | Matcher, intents, персональная связь и поколения соединения |
| Эксплуатация | Docker, Railway, Sentry | Изолированный staging до итогового release |
| Тесты | `node:test`, `node:assert/strict`, tsx, `test/fixtures/`; PostgreSQL integration | Сохранить стек, расширять по задачам; UI/E2E runner пока не объявлен внедрённым |

Версии здесь — ориентир исходной ветки. Установленные версии определяют
`package-lock.json`, `admin/package-lock.json`, manifests, Dockerfiles.
Не навязывай Next.js, NX, Tailwind, Zustand, Jest или новые зависимости.
Наличие `REDIS_URL` в старом environment schema не доказывает очередь Redis.

## Карта ответственности

- Реестр/фильтры v1: `scripts/search-settings.cjs`, `scripts/search-modules/`.
- API админки: `src/admin/`; UI: `admin/src/main.tsx`, `api.ts`, `style.css`.
- Каталог v1: `src/listings/`; БД: `prisma/schema.prisma`, `prisma/migrations/`.
- Общие browser lifecycle/profile/recovery и telemetry: соответствующие файлы
  `scripts/`; миграционный ownership — `docs/plans/platform-v2-typescript-inventory.md`.
- Целевые пути v2, создавать только по принятому плану: `web/`, `src/auth/`,
  `src/users/`, `src/searches/`, `src/catalog/`, `src/geography/`, `src/matching/`,
  `src/notifications/`, `src/telegram/`, `src/contracts/`.
- Источник выбирай через `docs/index.md`: один runbook + одна профильная страница.
  Имена Source ID не выводи из имени файла; у 123Wonen код использует `wonen123`.

## Константы и конфигурация

Не копируй значения в новую реализацию из инструкций. Найди владельца в коде,
проверь актуальный контракт и используй существующую конфигурацию/общий тип.

| Значение/контракт | Где проверять |
|---|---|
| Интервал v1: default 900 секунд, минимум 60 | `src/config/environment.ts`, `.env.example`, runner источника |
| Source IDs, диапазоны, defaults, query/server | Реестр и соответствующий search module; профильный Notion |
| Таймауты, lease, retries, backoff | Владеющий runner/browser/outbox модуль; не вводить универсальный timeout |
| Пауза sender v1 минимум 3100 мс | `src/delivery/outbox.service.ts`; не конечная модель квот v2 |
| Admin v1: сессия 8 часов, UI polling 15 с | `docs/admin.md` и реализация auth/UI; не переносить TTL на Google-сессии догадкой |
| V2: 5 поисков, 20 городов на пользователя, 50 объявлений на страницу | Подтверждение в плане/preparation; нужны конфигурируемые серверные лимиты, не только ограничения UI |
| V2 первый UI и сообщения — English | Подтверждение 31.10.2026; словарь строк без обязательной новой i18n-библиотеки |

Квота городов между поисками/paused-поисками ещё требует контракта A03/I03.
Не объявляй предложенные TTL, retention, rate limits или geocoder принятыми.

## Инварианты

- Новые собственные исполняемые исходники, тесты, CLI и программные конфиги —
  `.ts`/`.tsx`. Legacy JS/CJS/MJS переводится поэтапно с проверкой паритета;
  YAML/TOML/JSON/Markdown/HTML/CSS и собранный JS не запрещены.
- Сохраняй IDs, историю, baseline, outbox keys и encrypted browser state.
  Языковой перенос не меняет фильтры, доступность или доставку.
- Ошибка/partial run не означает пустой успешный сбор; не обновляет baseline
  или lastSuccessAt. Попытка и успех — разные показатели.
- Фильтры, servicekosten, неизвестные поля, доступность и география различаются
  по источникам. Национальный scope вводится явно для каждого адаптера.
- V2: collector → catalog/events → matcher → intents/outbox → delivery.
  Персональный поиск не управляет общим сбором. Тихие baselines, per-source
  watermarks, revisions/cancellation и Telegram generation fences обязательны
  по принятому контракту; существующий каталог не становится массовой рассылкой.
- Несколько поисков не дублируют один NEW одному пользователю; разные получатели
  независимы. Исчезновение карточки само по себе не означает сдачу квартиры.
- Не обещай exactly-once Telegram. Неоднозначный сетевой исход — `UNCERTAIN`,
  без слепой повторной отправки. Сеть не держать внутри долгой DB-транзакции.
- Tenant ownership, server sessions, CSRF/Origin и полномочия admin проверяет
  сервер. Google identity — issuer/sub; linking Telegram требует подтверждения
  в web, не доверяет переданному chatId. Секреты не идут в frontend/logs/docs.
- Мониторинг не использует LLM в runtime. CAPTCHA/MFA — ручное восстановление.
- Task branches и PR v2: от актуальной `origin/codex/platform-v2`, base PR
  `codex/platform-v2`. `main` — только итоговый release по отдельному поручению.
  Разработка/миграции/доставка проверяются в изолированном local/staging, со
  своими DB, bot, OAuth, volumes и профилями; имя ветки не даёт изоляции данных.

## Context7 для исполнителей

`backend-worker` и `frontend-worker` обязаны использовать доступный MCP Context7
при работе с библиотечными API, конфигурацией или подходами к интеграции:

1. Установи фактическую версию по manifest/lockfile и вопрос по задаче.
2. Вызови `resolve-library-id` (в этой среде `context7_resolve_library_id`),
   затем `query-docs` / `context7_query_docs` с полученным ID. Не угадывай ID.
3. Выбирай документацию совместимой версии; latest не означает совместимость.
   Укажи версию в запросе, если version-specific ID недоступен. Соблюдай лимиты
   инструмента, не отправляй приватный код, токены или пользовательские данные.
4. Применяй подтверждённые API в существующей архитектуре. Context7 не разрешает
   обновлять зависимости, менять контракт или устанавливать MCP без задания.
5. Переиспользуй переданную свежую выдержку для той же версии/вопроса. При новом
   API-вопросе сделай адресный запрос. Для чистой правки текста запрос не нужен.
6. Если Context7 недоступен/не покрывает версию, явно сообщи; проверь официальные
   docs и локальные typings исходной версии. Не выдавай fallback за Context7.
   Если критичный API проверить невозможно, верни BLOCKED с точным вопросом.

Другие роли применяют тот же порядок, когда пишут библиотечный код тестов или
проверяют спорный API. MCP наследуется от основной сессии; секреты и локальную
конфигурацию серверов в определения агентов не добавлять.

## Проверки и отчёт

- Реальные команды — в текущих `package.json`, README и CI. Сейчас: typecheck,
  `npm test`, `npm run build:all`, `npm run db:validate`; integration —
  `npm run test:integration` только с явно заданной отдельной тестовой БД.
- Backend tsconfig исходной ветки включает только `src/**/*.ts`; это не
  доказательство типизации legacy scripts/tests или будущего `web/`.
- Нет отдельного UI/E2E runner: не подменяй его сборкой и не добавляй новый стек
  автоматически. Различай PASSED / FAILED / BLOCKED / SKIPPED по каждой проверке.
- Unit/DB integration/browser smoke/staging E2E/production run доказывают разное.
  Не вызывай live-сайт, реальный sender, OAuth или production для обычной правки.
- Отчёт: результат, изменённые файлы, проверенные критерии, команды/exit codes,
  причины сбоев/пропусков, оставшиеся риски. Сохраняй полные длинные логи отдельно,
  в ответ передавай нужные assertions и безопасные выдержки.
