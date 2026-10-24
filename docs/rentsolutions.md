# Rent Solutions

[Согласованные требования в Notion](https://app.notion.com/p/402d10c6e6ab81ebbb19c049024bfe64?pvs=204). Runbook описывает реализацию;
датированные результаты ниже относятся к конкретным проверкам, а не live-статусу production.

Источник: [выдача Groningen до €1500](https://rent-solutions.nl/woning-aanbod/?_plaats=groningen&_price=0%2C1500).
Source ID: `rentsolutions:groningen`.

По указанию пользователя: Groningen, объявленная месячная аренда до €1500 включительно. Тип жилья и дата публикации не ограничиваются. Цена из выдачи подтверждена на странице объекта как `per maand`; дополнительные расходы из описаний не прибавляются.

Публичный HTTP GET без браузера и аккаунта. Город и диапазон цены передаются в FacetWP: `_plaats=groningen&_price=0,1500`. Проверяются точное эхо параметров, `url_vars`, диапазон слайдера `price.start`, заголовок, единственный контейнер, полное количество карточек, уникальные ID/URL, город, цена, площадь и комнаты. Цена вне запрошенного диапазона считается ошибкой. Выдача использует `per_page=-1`, `page=1`, `total_pages=1`; появление пагинации требует обновления адаптера, частичный ответ не сохраняется.

Нулевая выдача сайта содержит пустой контейнер без видимого сообщения: необходимы валидные фильтры, нулевой счётчик и `no_results_text=Geen resultaten gevonden`. Реальное пустое состояние проверено запросом `_price=0,1`. Fixtures сохраняют публичные карточки и метаданные проверки без скриптов сайта и nonce. Повреждённые ответы и варианты доступности в тестах синтетические.

ID — `h…` в `/object/…-hID/`. URL разрешены только HTTPS на `rent-solutions.nl`, без credentials, порта, query и fragment. Нидерландская цена `1.120` означает €1120; `1.120,50` — €1120,50. Только явный `Nieuw` подтверждает доступность: этот статус найден в полном каталоге у объекта в Marum. `Verhuurd`, `Verhuurd onder voorbehoud`, `Onder optie`, `Gereserveerd` недоступны; неизвестные, отсутствующие и противоречивые статусы не уведомляются.

HTTP-ошибка, редирект, challenge, неполная структура и дубликаты завершают проход ошибкой. До трёх попыток для сетевых ошибок и 502/503/504; cooldown при 429, общий timeout 120 секунд, максимум 8 MiB на ответ. На 16.10.2026 robots.txt разрешает доступ User-agent `*` без запретов. Отдельные условия использования этим не подтверждаются.

Штатные PostgreSQL lease, scheduler 900 секунд, отдельный тихий baseline и transactional Telegram outbox. Первый проход не рассылает старые объявления. `RENTSOLUTIONS_MONITORING_ENABLED=false` отключает источник без сброса baseline. Админка: pause, аренда от/до и минимальная площадь; цена применяется в запросе сайта, площадь перед уведомлением. Изменение фильтров использует штатное подавление исторических уведомлений.

Проверки:

```sh
node --import tsx --test test/rentsolutions.test.ts
npm run typecheck
npm test
npm run build:all
npm run db:validate
node scripts/rentsolutions-check.cjs
```

На 16.10.2026 live smoke: inspected=4, total=4, available=0, pages=1. Все четыре объявления в Groningen сданы. Локально прошли 126 unit-тестов, typecheck, backend/React build и Prisma validate. Добавлен PostgreSQL integration: отключение, независимый baseline, повторный проход, переход unknown → available, дедупликация, площадь и сохранение baseline/lastSuccessAt при ошибке. Запуск временной локальной PostgreSQL заблокирован read-only Docker storage; integration ещё не выполнен. Workflow `rentsolutions-smoke.yml` проверяет живой сайт без БД и отправки сообщений. Этот локальный smoke не проверял production и естественную доставку. Последующие CI и production-подтверждения сохранены в архиве Notion; они не являются live-статусом сегодня.
