# Инвентарь переноса TypeScript для v2

Дата: 31.10.2026. Срез `763b3170bc0c2da937efd07ac1096cc87b6dcf30` (`origin/main`). Это подготовленный вход для TS01; TS02/toolchain и TS10/CI guard ещё не реализованы.

Связанные документы: [план v2](multi-user-platform-v2.md), [подготовка и результаты](platform-v2-preparation.md).

## Собственные не-TS файлы

Источник списка: `git ls-files` с расширениями `.js/.jsx/.cjs/.mjs`. Всего 78 файлов: 61 .cjs, 17 .mjs. Generated, зависимости и build output не входят в tracked-список; HTML fixtures — тестовые данные, их нельзя автоматически удалять.

| Задача переноса | Файлов |
|---|---|
| C.funda.2 | 6 |
| C.gruno.2 | 3 |
| C.huurwoningen.2 | 9 |
| C.pararius.2 | 4 |
| C.woldring.2 | 3 |
| TS03 | 19 |
| TS04 | 1 |
| TS05 | 1 |
| TS06 | 6 |
| TS07 | 20 |
| TS08 | 6 |

Задача в таблице — владелец переноса файла. TS09 обновляет все команды, Docker COPY/CMD и CI после переноса; TS08 проверяет обнаружение всех тестов. TS03 включает source-specific модули фильтров: их семантика v1 сохраняется до явного переключения collection/search v2. Общий runner в `funda-runner.cjs` принадлежит TS04, несмотря на имя. Общий browser client — TS06; source-specific workers — C.<slug>.2.

| Файл | Строк | Владелец |
|---|---:|---|
| [scripts/admin-auth.cjs](../../scripts/admin-auth.cjs) | 25 | TS07 |
| [scripts/browser-lifecycle.cjs](../../scripts/browser-lifecycle.cjs) | 70 | TS06 |
| [scripts/browser-profile-smoke.cjs](../../scripts/browser-profile-smoke.cjs) | 79 | TS06 |
| [scripts/browser-profile.cjs](../../scripts/browser-profile.cjs) | 41 | TS06 |
| [scripts/browser-resources.cjs](../../scripts/browser-resources.cjs) | 15 | TS06 |
| [scripts/funda-browser-bootstrap.cjs](../../scripts/funda-browser-bootstrap.cjs) | 11 | C.funda.2 |
| [scripts/funda-browser-client.cjs](../../scripts/funda-browser-client.cjs) | 33 | TS06 |
| [scripts/funda-browser-session.cjs](../../scripts/funda-browser-session.cjs) | 405 | C.funda.2 |
| [scripts/funda-check.cjs](../../scripts/funda-check.cjs) | 30 | TS07 |
| [scripts/funda-core.cjs](../../scripts/funda-core.cjs) | 214 | C.funda.2 |
| [scripts/funda-runner.cjs](../../scripts/funda-runner.cjs) | 91 | TS04 |
| [scripts/funda-session-verify.cjs](../../scripts/funda-session-verify.cjs) | 21 | C.funda.2 |
| [scripts/gohome-check.cjs](../../scripts/gohome-check.cjs) | 5 | TS07 |
| [scripts/gruno-check.cjs](../../scripts/gruno-check.cjs) | 4 | TS07 |
| [scripts/gruno-core.cjs](../../scripts/gruno-core.cjs) | 204 | C.gruno.2 |
| [scripts/gruno-runner.cjs](../../scripts/gruno-runner.cjs) | 9 | C.gruno.2 |
| [scripts/huurwoningen-browser-bootstrap.cjs](../../scripts/huurwoningen-browser-bootstrap.cjs) | 10 | C.huurwoningen.2 |
| [scripts/huurwoningen-browser-session.cjs](../../scripts/huurwoningen-browser-session.cjs) | 9 | C.huurwoningen.2 |
| [scripts/huurwoningen-core.cjs](../../scripts/huurwoningen-core.cjs) | 150 | C.huurwoningen.2 |
| [scripts/huurwoningen-experiment.cjs](../../scripts/huurwoningen-experiment.cjs) | 54 | C.huurwoningen.2 |
| [scripts/huurwoningen-patchright-session.cjs](../../scripts/huurwoningen-patchright-session.cjs) | 41 | C.huurwoningen.2 |
| [scripts/huurwoningen-runner.cjs](../../scripts/huurwoningen-runner.cjs) | 9 | C.huurwoningen.2 |
| [scripts/huurwoningen-session-verify.cjs](../../scripts/huurwoningen-session-verify.cjs) | 12 | C.huurwoningen.2 |
| [scripts/ikwilhuren-check.cjs](../../scripts/ikwilhuren-check.cjs) | 4 | TS07 |
| [scripts/lamberink-check.cjs](../../scripts/lamberink-check.cjs) | 4 | TS07 |
| [scripts/maxx-check.cjs](../../scripts/maxx-check.cjs) | 4 | TS07 |
| [scripts/outbox-admin.mjs](../../scripts/outbox-admin.mjs) | 25 | TS07 |
| [scripts/outbox-smoke.mjs](../../scripts/outbox-smoke.mjs) | 70 | TS07 |
| [scripts/pararius-browser-session.cjs](../../scripts/pararius-browser-session.cjs) | 42 | C.pararius.2 |
| [scripts/pararius-check.cjs](../../scripts/pararius-check.cjs) | 12 | TS07 |
| [scripts/pararius-core.cjs](../../scripts/pararius-core.cjs) | 179 | C.pararius.2 |
| [scripts/pararius-profile-smoke.cjs](../../scripts/pararius-profile-smoke.cjs) | 36 | TS06 |
| [scripts/pararius-runner.cjs](../../scripts/pararius-runner.cjs) | 9 | C.pararius.2 |
| [scripts/prepare-huurwoningen-experiment.cjs](../../scripts/prepare-huurwoningen-experiment.cjs) | 24 | TS07 |
| [scripts/rentbilly-check.cjs](../../scripts/rentbilly-check.cjs) | 5 | TS07 |
| [scripts/rentola-check.cjs](../../scripts/rentola-check.cjs) | 18 | TS07 |
| [scripts/rentsolutions-check.cjs](../../scripts/rentsolutions-check.cjs) | 4 | TS07 |
| [scripts/search-modules/fields.cjs](../../scripts/search-modules/fields.cjs) | 17 | TS03 |
| [scripts/search-modules/funda.cjs](../../scripts/search-modules/funda.cjs) | 18 | TS03 |
| [scripts/search-modules/gohome.cjs](../../scripts/search-modules/gohome.cjs) | 27 | TS03 |
| [scripts/search-modules/gruno.cjs](../../scripts/search-modules/gruno.cjs) | 19 | TS03 |
| [scripts/search-modules/huurwoningen.cjs](../../scripts/search-modules/huurwoningen.cjs) | 18 | TS03 |
| [scripts/search-modules/ikwilhuren.cjs](../../scripts/search-modules/ikwilhuren.cjs) | 8 | TS03 |
| [scripts/search-modules/lamberink.cjs](../../scripts/search-modules/lamberink.cjs) | 25 | TS03 |
| [scripts/search-modules/maxx.cjs](../../scripts/search-modules/maxx.cjs) | 15 | TS03 |
| [scripts/search-modules/pararius.cjs](../../scripts/search-modules/pararius.cjs) | 9 | TS03 |
| [scripts/search-modules/rentbilly.cjs](../../scripts/search-modules/rentbilly.cjs) | 11 | TS03 |
| [scripts/search-modules/rentola.cjs](../../scripts/search-modules/rentola.cjs) | 9 | TS03 |
| [scripts/search-modules/rentsolutions.cjs](../../scripts/search-modules/rentsolutions.cjs) | 27 | TS03 |
| [scripts/search-modules/rotsvast.cjs](../../scripts/search-modules/rotsvast.cjs) | 9 | TS03 |
| [scripts/search-modules/solide.cjs](../../scripts/search-modules/solide.cjs) | 13 | TS03 |
| [scripts/search-modules/vandermeulen.cjs](../../scripts/search-modules/vandermeulen.cjs) | 15 | TS03 |
| [scripts/search-modules/vesteda.cjs](../../scripts/search-modules/vesteda.cjs) | 19 | TS03 |
| [scripts/search-modules/woldring.cjs](../../scripts/search-modules/woldring.cjs) | 25 | TS03 |
| [scripts/search-modules/wonen123.cjs](../../scripts/search-modules/wonen123.cjs) | 9 | TS03 |
| [scripts/search-settings.cjs](../../scripts/search-settings.cjs) | 70 | TS03 |
| [scripts/sentry-smoke.cjs](../../scripts/sentry-smoke.cjs) | 21 | TS07 |
| [scripts/solide-check.cjs](../../scripts/solide-check.cjs) | 4 | TS07 |
| [scripts/telegram-client.mjs](../../scripts/telegram-client.mjs) | 112 | TS07 |
| [scripts/telegram-setup.mjs](../../scripts/telegram-setup.mjs) | 33 | TS07 |
| [scripts/telemetry.cjs](../../scripts/telemetry.cjs) | 86 | TS05 |
| [scripts/vandermeulen-check.cjs](../../scripts/vandermeulen-check.cjs) | 4 | TS07 |
| [scripts/vesteda-check.cjs](../../scripts/vesteda-check.cjs) | 4 | TS07 |
| [scripts/woldring-core.cjs](../../scripts/woldring-core.cjs) | 110 | C.woldring.2 |
| [scripts/woldring-runner.cjs](../../scripts/woldring-runner.cjs) | 9 | C.woldring.2 |
| [test/admin-settings.test.mjs](../../test/admin-settings.test.mjs) | 151 | TS08 |
| [test/browser-lifecycle.test.mjs](../../test/browser-lifecycle.test.mjs) | 146 | TS08 |
| [test/browser-recovery-ui.test.mjs](../../test/browser-recovery-ui.test.mjs) | 61 | TS08 |
| [test/funda-browser-client.test.mjs](../../test/funda-browser-client.test.mjs) | 23 | TS08 |
| [test/funda-browser-session.test.mjs](../../test/funda-browser-session.test.mjs) | 155 | C.funda.2 |
| [test/funda.test.mjs](../../test/funda.test.mjs) | 118 | C.funda.2 |
| [test/gruno.test.mjs](../../test/gruno.test.mjs) | 140 | C.gruno.2 |
| [test/huurwoningen-experiment.test.mjs](../../test/huurwoningen-experiment.test.mjs) | 60 | C.huurwoningen.2 |
| [test/huurwoningen.test.mjs](../../test/huurwoningen.test.mjs) | 96 | C.huurwoningen.2 |
| [test/pararius.test.mjs](../../test/pararius.test.mjs) | 85 | C.pararius.2 |
| [test/telegram.test.mjs](../../test/telegram.test.mjs) | 73 | TS08 |
| [test/telemetry.test.mjs](../../test/telemetry.test.mjs) | 119 | TS08 |
| [test/woldring.test.mjs](../../test/woldring.test.mjs) | 43 | C.woldring.2 |

## Точки запуска и упаковка

| Поверхность | Текущий контракт | Изменение |
|---|---|---|
| `package.json` → `build` | `tsc -p tsconfig.json` | TS02/TS09: актуальный TS entrypoint или сборка; сохранить назначение команды |
| `package.json` → `start` | `node dist/main.js` | TS02/TS09: актуальный TS entrypoint или сборка; сохранить назначение команды |
| `package.json` → `start:dev` | `tsx watch src/main.ts` | TS02/TS09: актуальный TS entrypoint или сборка; сохранить назначение команды |
| `package.json` → `typecheck` | `tsc --noEmit` | TS02/TS09: актуальный TS entrypoint или сборка; сохранить назначение команды |
| `package.json` → `test` | `node --import tsx --test test/*.test.ts test/*.test.mjs` | TS02/TS09: актуальный TS entrypoint или сборка; сохранить назначение команды |
| `package.json` → `telegram:check` | `node --env-file-if-exists=.env scripts/telegram-setup.mjs check` | TS02/TS09: актуальный TS entrypoint или сборка; сохранить назначение команды |
| `package.json` → `telegram:chats` | `node --env-file-if-exists=.env scripts/telegram-setup.mjs chats` | TS02/TS09: актуальный TS entrypoint или сборка; сохранить назначение команды |
| `package.json` → `telegram:test` | `node --env-file-if-exists=.env scripts/telegram-setup.mjs test` | TS02/TS09: актуальный TS entrypoint или сборка; сохранить назначение команды |
| `package.json` → `db:validate` | `prisma validate` | TS02/TS09: актуальный TS entrypoint или сборка; сохранить назначение команды |
| `package.json` → `db:generate` | `prisma generate` | TS02/TS09: актуальный TS entrypoint или сборка; сохранить назначение команды |
| `package.json` → `db:migrate` | `prisma migrate dev` | TS02/TS09: актуальный TS entrypoint или сборка; сохранить назначение команды |
| `package.json` → `db:deploy` | `prisma migrate deploy` | TS02/TS09: актуальный TS entrypoint или сборка; сохранить назначение команды |
| `package.json` → `test:integration` | `node --import tsx --test --test-concurrency=1 test/integration/*.test.ts` | TS02/TS09: актуальный TS entrypoint или сборка; сохранить назначение команды |
| `package.json` → `outbox:admin` | `node --env-file-if-exists=.env scripts/outbox-admin.mjs` | TS02/TS09: актуальный TS entrypoint или сборка; сохранить назначение команды |
| `package.json` → `outbox:smoke` | `node --env-file-if-exists=.env scripts/outbox-smoke.mjs` | TS02/TS09: актуальный TS entrypoint или сборка; сохранить назначение команды |
| `package.json` → `funda:check` | `node --env-file-if-exists=.env scripts/funda-check.cjs` | TS02/TS09: актуальный TS entrypoint или сборка; сохранить назначение команды |
| `package.json` → `test:funda` | `node --test test/funda.test.mjs` | TS02/TS09: актуальный TS entrypoint или сборка; сохранить назначение команды |
| `package.json` → `sentry:smoke` | `node --env-file-if-exists=.env scripts/sentry-smoke.cjs` | TS02/TS09: актуальный TS entrypoint или сборка; сохранить назначение команды |
| `package.json` → `admin:dev` | `npm --prefix admin run dev` | TS02/TS09: актуальный TS entrypoint или сборка; сохранить назначение команды |
| `package.json` → `admin:build` | `npm --prefix admin run build` | TS02/TS09: актуальный TS entrypoint или сборка; сохранить назначение команды |
| `package.json` → `build:all` | `npm run build && npm run admin:build` | TS02/TS09: актуальный TS entrypoint или сборка; сохранить назначение команды |
| `admin/package.json` → `dev` | `vite --host 0.0.0.0` | TS02/TS09: актуальный TS entrypoint или сборка; сохранить назначение команды |
| `admin/package.json` → `build` | `tsc --noEmit && vite build` | TS02/TS09: актуальный TS entrypoint или сборка; сохранить назначение команды |
| `Dockerfile:29` | `CMD ["node", "dist/main.js"]` | TS09; проверить build/runtime после переноса |
| `Dockerfile.browser:9` | `CMD ["node", "scripts/funda-browser-session.cjs"]` | TS09; проверить build/runtime после переноса |
| `Dockerfile.huurwoningen-browser:9` | `CMD ["node", "scripts/huurwoningen-browser-session.cjs"]` | TS09; проверить build/runtime после переноса |
| `Dockerfile.huurwoningen-experiment:9` | `RUN node -e "const fs=require('node:fs'); const p='/opt/housing-browser/REVISION'; const sha=process.env.RAILWAY_GIT_COMMIT_SHA \|\| (fs.existsSync(p) ? fs.readFileSync(p,'utf8').trim() : ''); if(!/^[a-f0-9]{40}$/.test(sha)) throw Error('RELEASE_INVALID'); fs.writeFileSync('/app/REVISION',sha+'\n');"` | TS09; проверить build/runtime после переноса |
| `Dockerfile.huurwoningen-experiment:13` | `CMD ["node", "scripts/huurwoningen-patchright-session.cjs"]` | TS09; проверить build/runtime после переноса |
| `Dockerfile.pararius-browser:9` | `RUN node -e "const fs=require('node:fs'); const p='/opt/housing-browser/REVISION'; const sha=process.env.RAILWAY_GIT_COMMIT_SHA \|\| (fs.existsSync(p) ? fs.readFileSync(p,'utf8').trim() : ''); if(!/^[a-f0-9]{40}$/.test(sha)) throw Error('RELEASE_INVALID'); fs.writeFileSync('/app/REVISION',sha+'\n');"` | TS09; проверить build/runtime после переноса |
| `Dockerfile.pararius-browser:13` | `CMD ["node", "scripts/pararius-browser-session.cjs"]` | TS09; проверить build/runtime после переноса |
| `compose.yaml:17` | `    command: ["redis-server", "--appendonly", "yes"]` | TS09; проверить build/runtime после переноса |
| `compose.yaml:29` | `    command: ["sh", "-c", "npm run db:deploy && exec node dist/main.js"]` | TS09; проверить build/runtime после переноса |

Production Railway Start Command хранится отдельно от Git. По `docs/railway.md` есть Funda, Huurwoningen и Pararius workers; актуальные удалённые настройки здесь не проверялись. Их Start/Pre-deploy, source branch и volumes нужно проверить в B03/B04/O05. Наличие Dockerfile не доказывает использование сервиса; альтернативный `Dockerfile.huurwoningen-browser` нельзя удалить без проверки потребителей.

## Inline JavaScript в CI и Docker

Все найденные места ниже принадлежат TS09: заменить исполняемыми TS-утилитами и обновить упаковку. Не ограничиваться расширениями файлов.

| Место | Назначение |
|---|---|
| `.github/workflows/ci.yml:18` | Smoke/assertions CI |
| `.github/workflows/ci.yml:29` | Smoke/assertions CI |
| `.github/workflows/ci.yml:36` | Smoke/assertions CI |
| `.github/workflows/ikwilhuren-smoke.yml:24` | Smoke/assertions CI |
| `.github/workflows/lamberink-smoke.yml:24` | Smoke/assertions CI |
| `.github/workflows/maxx-smoke.yml:24` | Smoke/assertions CI |
| `.github/workflows/rentsolutions-smoke.yml:24` | Smoke/assertions CI |
| `.github/workflows/rotsvast-smoke.yml:24` | Smoke/assertions CI |
| `.github/workflows/vandermeulen-smoke.yml:24` | Smoke/assertions CI |
| `.github/workflows/wonen123-smoke.yml:24` | Smoke/assertions CI |
| `Dockerfile.huurwoningen-experiment:9` | Запись/валидация REVISION |
| `Dockerfile.pararius-browser:9` | Запись/валидация REVISION |

## Потребители legacy-кода в TypeScript

Ниже адресные ссылки на строки с `.cjs/.mjs/.js/.jsx`. Это дополнение к инвентарю; динамические require, строки внутри `page.evaluate` и встроенный HTML/JS проверяются вручную при переносе соответствующего модуля. Отдельный машинный guard с зафиксированными исключениями входит в TS10.

| Файл | Строки ссылок |
|---|---|
| [src/admin/admin.controller.ts](../../src/admin/admin.controller.ts) | 17 |
| [src/admin/admin.service.ts](../../src/admin/admin.service.ts) | 23 |
| [src/delivery/outbox.service.ts](../../src/delivery/outbox.service.ts) | 19, 63 |
| [src/instrument.ts](../../src/instrument.ts) | 2 |
| [src/listings/listings.service.ts](../../src/listings/listings.service.ts) | 33 |
| [src/main.ts](../../src/main.ts) | 24 |
| [src/sources/funda.service.ts](../../src/sources/funda.service.ts) | 6, 10, 14, 35 |
| [src/sources/gohome-core.ts](../../src/sources/gohome-core.ts) | 4, 6 |
| [src/sources/gohome-runner.ts](../../src/sources/gohome-runner.ts) | 9 |
| [src/sources/gohome.service.ts](../../src/sources/gohome.service.ts) | 29 |
| [src/sources/gruno.service.ts](../../src/sources/gruno.service.ts) | 5, 6, 29 |
| [src/sources/huurwoningen.service.ts](../../src/sources/huurwoningen.service.ts) | 6, 7, 8, 28 |
| [src/sources/ikwilhuren-core.ts](../../src/sources/ikwilhuren-core.ts) | 9 |
| [src/sources/ikwilhuren-runner.ts](../../src/sources/ikwilhuren-runner.ts) | 9 |
| [src/sources/ikwilhuren.service.ts](../../src/sources/ikwilhuren.service.ts) | 29 |
| [src/sources/lamberink-core.ts](../../src/sources/lamberink-core.ts) | 6 |
| [src/sources/lamberink-runner.ts](../../src/sources/lamberink-runner.ts) | 9 |
| [src/sources/lamberink.service.ts](../../src/sources/lamberink.service.ts) | 29 |
| [src/sources/maxx-core.ts](../../src/sources/maxx-core.ts) | 4, 8 |
| [src/sources/maxx-runner.ts](../../src/sources/maxx-runner.ts) | 9 |
| [src/sources/maxx.service.ts](../../src/sources/maxx.service.ts) | 29 |
| [src/sources/pararius.service.ts](../../src/sources/pararius.service.ts) | 6, 7, 8, 28 |
| [src/sources/rentbilly-core.ts](../../src/sources/rentbilly-core.ts) | 4, 9, 28 |
| [src/sources/rentbilly-runner.ts](../../src/sources/rentbilly-runner.ts) | 9 |
| [src/sources/rentbilly.service.ts](../../src/sources/rentbilly.service.ts) | 29 |
| [src/sources/rentola-core.ts](../../src/sources/rentola-core.ts) | 5, 32, 45 |
| [src/sources/rentola-runner.ts](../../src/sources/rentola-runner.ts) | 12 |
| [src/sources/rentola.service.ts](../../src/sources/rentola.service.ts) | 29 |
| [src/sources/rentsolutions-core.ts](../../src/sources/rentsolutions-core.ts) | 5, 9 |
| [src/sources/rentsolutions-runner.ts](../../src/sources/rentsolutions-runner.ts) | 9 |
| [src/sources/rentsolutions.service.ts](../../src/sources/rentsolutions.service.ts) | 29 |
| [src/sources/rotsvast-core.ts](../../src/sources/rotsvast-core.ts) | 4, 8 |
| [src/sources/rotsvast-runner.ts](../../src/sources/rotsvast-runner.ts) | 9 |
| [src/sources/rotsvast.service.ts](../../src/sources/rotsvast.service.ts) | 29 |
| [src/sources/solide-core.ts](../../src/sources/solide-core.ts) | 4, 9 |
| [src/sources/solide-runner.ts](../../src/sources/solide-runner.ts) | 9 |
| [src/sources/solide.service.ts](../../src/sources/solide.service.ts) | 29 |
| [src/sources/vandermeulen-core.ts](../../src/sources/vandermeulen-core.ts) | 5, 9 |
| [src/sources/vandermeulen-runner.ts](../../src/sources/vandermeulen-runner.ts) | 9 |
| [src/sources/vandermeulen.service.ts](../../src/sources/vandermeulen.service.ts) | 29 |
| [src/sources/vesteda-core.ts](../../src/sources/vesteda-core.ts) | 7, 15 |
| [src/sources/vesteda-runner.ts](../../src/sources/vesteda-runner.ts) | 9 |
| [src/sources/vesteda.service.ts](../../src/sources/vesteda.service.ts) | 29 |
| [src/sources/woldring.service.ts](../../src/sources/woldring.service.ts) | 5, 6, 25 |
| [src/sources/wonen123-core.ts](../../src/sources/wonen123-core.ts) | 5, 10 |
| [src/sources/wonen123-runner.ts](../../src/sources/wonen123-runner.ts) | 9 |
| [src/sources/wonen123.service.ts](../../src/sources/wonen123.service.ts) | 29 |
| [test/gohome.test.ts](../../test/gohome.test.ts) | 5 |
| [test/ikwilhuren.test.ts](../../test/ikwilhuren.test.ts) | 6 |
| [test/integration/admin.test.ts](../../test/integration/admin.test.ts) | 10, 11 |
| [test/integration/outbox.test.ts](../../test/integration/outbox.test.ts) | 11, 14, 15, 16, 17, 18, 19, 256, 329, 384, 406, 407, 428, 473, 512, 586, 625, 664, 703, 765, 767, 769, 780, 811, 821, 846, 886, 929, 973, 1024 |
| [test/lamberink.test.ts](../../test/lamberink.test.ts) | 5 |
| [test/maxx.test.ts](../../test/maxx.test.ts) | 5 |
| [test/rentbilly.test.ts](../../test/rentbilly.test.ts) | 5 |
| [test/rentola.test.ts](../../test/rentola.test.ts) | 5, 116 |
| [test/rentsolutions.test.ts](../../test/rentsolutions.test.ts) | 5 |
| [test/rotsvast.test.ts](../../test/rotsvast.test.ts) | 5 |
| [test/solide.test.ts](../../test/solide.test.ts) | 6 |
| [test/vandermeulen.test.ts](../../test/vandermeulen.test.ts) | 5 |
| [test/wonen123.test.ts](../../test/wonen123.test.ts) | 5 |

## Условия завершения TS01 и следующий шаг

- Проверить назначения файлов при старте TS02; не объявлять перенос завершённым по одному переименованию расширений.
- Зафиксировать module/runtime контракт для CommonJS NestJS, ESM Vite/admin и browser images. Сейчас backend strict покрывает только `src/**/*.ts`; scripts/tests/browser code не входят в `tsconfig.json`.
- TS10 должен запрещать новые не-TS файлы и inline JS, а также рост утверждённого legacy-списка. Этот документ пока не обеспечивает такой запрет.
- После удаления каждого legacy entrypoint проверить все consumers и команды. После переноса адаптера выполнить C.<slug>.3; source-specific приёмку нельзя заменить общей сборкой.
- К TS11 список собственного не-TS кода должен быть пустым, с сохранением тестов и runtime smoke всех используемых образов.
