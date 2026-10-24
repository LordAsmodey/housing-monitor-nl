# Funda

[Требования в Notion](https://app.notion.com/p/402d10c6e6ab8195868de764fcdce855?pvs=204) · [Ручное восстановление и worker](funda-browser-session.md)

Согласованный поиск:
<https://www.funda.nl/zoeken/huur?selected_area=groningen&radius_search=30&price=0-1500&publication_date=1>.

Groningen +30 км, объявленная аренда до €1500, публикации **за сегодня**.
Географию, бюджет и свежесть применяет Funda; не повторять в карточках расчёт расстояния
или окно 72 часа. Минимальная площадь применяется по сохранённой настройке админки.
Детали семантики даты: [funda-today-search.md](funda-today-search.md).

## Подключение и контракт

Production-путь использует отдельный браузерный worker, NestJS scheduler, PostgreSQL lease
и Telegram outbox. `FUNDA_BROWSER_ORIGIN` и `FUNDA_BROWSER_TOKEN` подключают worker
к приложению. Исторический Source ID `funda:groningen-30km-1500-3d` сохраняется,
несмотря на изменённую свежесть; переименование сбросило бы привязку истории.

Проверяются все страницы, счётчик, полнота, URL, структура и доступность. Human-check,
неполная выдача и ошибки не становятся успешным нулём. При сбое сохраняются прежние
baseline и lastSuccessAt. Дата публикации необязательна для отображения и не подменяется
detectedAt. После простоя через полночь вчерашние объявления могут быть пропущены:
трёхдневный catch-up не согласован.

Основная логика: `scripts/funda-core.cjs`, `scripts/funda-runner.cjs`,
`scripts/funda-browser-client.cjs`; подключение — `src/sources/funda.service.ts`.
Фильтры — `scripts/search-modules/funda.cjs`, общая обработка — `scripts/search-settings.cjs`.
Смена настроек использует snapshot/revision и тихий первый полный сбор новой версии.

## Проверки

```sh
node --test test/funda.test.mjs test/funda-browser-client.test.mjs test/funda-browser-session.test.mjs
npm run typecheck
npm run build
```

`npm run funda:check -- --dry-run` проверяет прямой HTTP-путь; он не использует
browser worker. Вариант `--once` запускает запись в БД/outbox и не является read-only smoke.
Для browser smoke используется `browserClient.collect` со снимком фильтров, как ниже
(команда читает источник с исходными фильтрами реестра, без БД и Telegram):

```sh
node --env-file=.env <<'NODE'
const { browserClient } = require('./scripts/funda-browser-client.cjs');
const { defaults } = require('./scripts/search-settings.cjs');
const { SOURCE_ID } = require('./scripts/funda-core.cjs');
browserClient(process.env.FUNDA_BROWSER_ORIGIN, process.env.FUNDA_BROWSER_TOKEN)
  .collect({ settings: defaults(SOURCE_ID) })
  .then(({ inspected, listings, pages }) => {
    console.log(JSON.stringify({ inspected, matched: listings.length, pages }));
  })
  .catch(error => {
    console.error(/^[A-Z_]+$/.test(error.category ?? '') ? error.category : 'FUNDA_CHECK_FAILED');
    process.exitCode = 1;
  });
NODE
```

Для проверки текущих изменённых настроек передавайте их snapshot вместо defaults.
Ошибка доступа не подтверждает отсутствие объявлений. PostgreSQL/outbox проверяются
отдельными интеграционными тестами. Работоспособность UI восстановления не доказывает
полный сбор, а live smoke — естественную Telegram-доставку.

[Старый HTTP-прототип и правила 72 часов](archive/funda-http-prototype.md) сохранены
только для истории; они не описывают действующий поиск.
