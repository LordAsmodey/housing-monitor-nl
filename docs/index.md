# Навигация по проекту

[Требования и общие правила в Notion](https://app.notion.com/p/3f6d10c6e6ab81fe8b06e6eebb9c9455) — источник продуктовых решений. Этот индекс связывает требования с кодом и эксплуатационными инструкциями; он не является копией требований или live-статусом production.

## Выбор контекста

| Задача | Страница требований | Локальные инструкции и код |
|---|---|---|
| Общие контракты, архитектура, БД, scheduler | [Архитектура](https://app.notion.com/p/402d10c6e6ab81f1a46cdcc948bb4faa?pvs=204) | `src/listings/`, `src/database/`, `prisma/schema.prisma`, `scripts/funda-runner.cjs` |
| UI, авторизация, сохранённые фильтры | [Админка](https://app.notion.com/p/3fad10c6e6ab810f8b6ac405dee44aeb) | [admin.md](admin.md), `admin/src/`, `src/admin/`, `scripts/search-settings.cjs`, `scripts/search-modules/` |
| Telegram и доставка | [Архитектура](https://app.notion.com/p/402d10c6e6ab81f1a46cdcc948bb4faa?pvs=204) | [outbox.md](outbox.md), [telegram.md](telegram.md), `src/delivery/` |
| Браузер, сессия, ручное восстановление | Страница нужного источника ниже | Его runbook; `scripts/*browser-session.cjs`, `scripts/browser-profile.cjs`, `scripts/browser-lifecycle.cjs` |
| Railway, сборка, выпуск | [Архитектура](https://app.notion.com/p/402d10c6e6ab81f1a46cdcc948bb4faa?pvs=204) | [railway.md](railway.md), Dockerfile нужного сервиса, `.github/workflows/` |
| Sentry, ошибки и здоровье | [Архитектура](https://app.notion.com/p/402d10c6e6ab81f1a46cdcc948bb4faa?pvs=204) | [sentry.md](sentry.md), `src/health/`, `scripts/telemetry.cjs` |
| Память и idle браузеров | Страница нужного источника | [browser-optimization.md](browser-optimization.md), `scripts/browser-resources.cjs` |
| Следующая задача, технический долг | [Backlog](https://app.notion.com/p/402d10c6e6ab815983ddf6700505fc7c?pvs=204) | [roadmap.md](roadmap.md) |
| Приёмка MVP | [Критерии и границы](https://app.notion.com/p/402d10c6e6ab81ce8707f7bab329ead7?pvs=204) | Проверки затронутых компонентов, `test/`, `test/integration/` |
| Компактная диагностика и передача задачи | — | Нужный раздел [agent-workflow.md](agent-workflow.md) |

При работе с одним источником открывайте одну строку ниже, соответствующий runbook и затронутую реализацию. Другие источники нужны, только если меняется общий код. Сначала используйте уже прочитанные сведения; не перечитывайте неизменившиеся страницы.

## Источники

[Общий каталог требований](https://app.notion.com/p/402d10c6e6ab81029473ed0ef6520025?pvs=204). В таблице — прямые ссылки, чтобы не читать каталог целиком. Идентификаторы, значения полей и места применения query/server определяет `scripts/search-settings.cjs` с `scripts/search-modules/`; NestJS подключение — `src/sources/<имя>.service.ts`. У 123Wonen имя файла — `wonen123`.

| Источник | Требования | Runbook | Основная логика |
|---|---|---|---|
| Funda | [Notion](https://app.notion.com/p/402d10c6e6ab8195868de764fcdce855?pvs=204) | [funda.md](funda.md) | `scripts/funda-core.cjs, scripts/funda-runner.cjs` |
| Huurwoningen | [Notion](https://app.notion.com/p/402d10c6e6ab81a0a21cdc1e43470e18?pvs=204) | [huurwoningen.md](huurwoningen.md) | `scripts/huurwoningen-core.cjs, scripts/huurwoningen-runner.cjs` |
| Woldring Verhuur | [Notion](https://app.notion.com/p/402d10c6e6ab81d494ccf25dc2f3d470?pvs=204) | [woldring.md](woldring.md) | `scripts/woldring-core.cjs, scripts/woldring-runner.cjs` |
| Vesteda | [Notion](https://app.notion.com/p/402d10c6e6ab81769d81ce16ba836c73?pvs=204) | [vesteda.md](vesteda.md) | `src/sources/vesteda-core.ts, src/sources/vesteda-runner.ts` |
| Gruno Verhuur | [Notion](https://app.notion.com/p/402d10c6e6ab81b286a1cb783a20164a?pvs=204) | [gruno.md](gruno.md) | `scripts/gruno-core.cjs, scripts/gruno-runner.cjs` |
| Lamberink | [Notion](https://app.notion.com/p/402d10c6e6ab81709385d2ce619024e1?pvs=204) | [lamberink.md](lamberink.md) | `src/sources/lamberink-core.ts, src/sources/lamberink-runner.ts` |
| Solide Verhuur | [Notion](https://app.notion.com/p/402d10c6e6ab8147b881c9787a3fd749?pvs=204) | [solide.md](solide.md) | `src/sources/solide-core.ts, src/sources/solide-runner.ts` |
| Van der Meulen | [Notion](https://app.notion.com/p/402d10c6e6ab818d8ac5cfb5835d1a21?pvs=204) | [vandermeulen.md](vandermeulen.md) | `src/sources/vandermeulen-core.ts, src/sources/vandermeulen-runner.ts` |
| Maxx Huren | [Notion](https://app.notion.com/p/402d10c6e6ab813fbed3daa0bea6c33f?pvs=204) | [maxx.md](maxx.md) | `src/sources/maxx-core.ts, src/sources/maxx-runner.ts` |
| Rent Solutions | [Notion](https://app.notion.com/p/402d10c6e6ab81ebbb19c049024bfe64?pvs=204) | [rentsolutions.md](rentsolutions.md) | `src/sources/rentsolutions-core.ts, src/sources/rentsolutions-runner.ts` |
| Rentola | [Notion](https://app.notion.com/p/402d10c6e6ab81e9adaaeb9b92e2baed?pvs=204) | [rentola.md](rentola.md) | `src/sources/rentola-core.ts, src/sources/rentola-runner.ts` |
| Pararius | [Notion](https://app.notion.com/p/402d10c6e6ab816ba5d4dfe6407fa7e7?pvs=204) | [pararius.md](pararius.md) | `scripts/pararius-core.cjs, scripts/pararius-runner.cjs` |
| 123Wonen | [Notion](https://app.notion.com/p/402d10c6e6ab8128890cfe65652e7165?pvs=204) | [123wonen.md](123wonen.md) | `src/sources/wonen123-core.ts, src/sources/wonen123-runner.ts` |
| Rotsvast | [Notion](https://app.notion.com/p/402d10c6e6ab810fbabdc858be3a62b2?pvs=204) | [rotsvast.md](rotsvast.md) | `src/sources/rotsvast-core.ts, src/sources/rotsvast-runner.ts` |
| RentBilly | [Notion](https://app.notion.com/p/402d10c6e6ab81fa886bf37027b53770?pvs=204) | [rentbilly.md](rentbilly.md) | `src/sources/rentbilly-core.ts, src/sources/rentbilly-runner.ts` |
| GoHome | [Notion](https://app.notion.com/p/402d10c6e6ab81129bffc11b1dc8cca6?pvs=204) | [gohome.md](gohome.md) | `src/sources/gohome-core.ts, src/sources/gohome-runner.ts` |
| ikwilhuren.nu | [Notion](https://app.notion.com/p/402d10c6e6ab81a68d09f88f50940c2e?pvs=204) | [ikwilhuren.md](ikwilhuren.md) | `src/sources/ikwilhuren-core.ts, src/sources/ikwilhuren-runner.ts` |

Поисковые фильтры индивидуальны. Не переносите радиус/свежесть Funda или запрет комнат на остальные сайты. Сохранённые настройки приложения могут отличаться от исходных значений в требованиях.

## Проверки

Команды сборки и общих проверок — в [README](../README.md). Для изменения адаптера начните с его unit-теста и подходящей интеграционной проверки. Live smoke из runbook читает внешний сайт; он не доказывает работу production scheduler или доставку Telegram. Для изменения документации достаточно проверки ссылок, сохранности требований и отсутствия противоречий.

## История — по необходимости

- [Полный снимок прежней страницы Notion и история внедрений](https://app.notion.com/p/402d10c6e6ab8160b20bd820b9734757?pvs=204).
- [Архив локальной документации](archive/index.md).
- `docs/research/`, [gruno-research.md](gruno-research.md), [huurwoningen-experiment.md](huurwoningen-experiment.md), [initialization-validation.md](initialization-validation.md) — исследования и датированные проверки, а не текущие общие требования.
- Браузерный production Huurwoningen использует Chrome; слово experiment в имени Dockerfile/сервиса историческое.

Новые требования обновляйте на профильной странице Notion. В runbook меняйте команды, контракт реализации и ограничения; историю проверки записывайте с датой и отдельным обозначением её границ. Главную страницу и README держите краткими. Полную двуязычную копию требований и автоматически растущий журнал в обязательный контекст не добавляйте.
