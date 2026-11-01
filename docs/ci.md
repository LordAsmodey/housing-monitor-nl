# CI и защита веток

Контракт B02 из [плана v2, §11](plans/multi-user-platform-v2.md#11-миграция-и-выпуск-без-массовой-рассылки). Реализация: [workflow](../.github/workflows/ci.yml), [guard](../scripts/ci-pr-target-guard.ts), [тесты](../test/ci-pr-target-guard.test.ts). Это проверка маршрута PR и его merge-result; выпуск и deployment требуют отдельных этапов B04/R09–R12.

## Маршруты PR

| Head | Допустимая base | Результат guard |
|---|---|---|
| Задача v2 `codex/<backlog-id>-<slug>` | `codex/platform-v2` | `v2-task`; другая base, включая `main`, отклоняется |
| `codex/platform-v2` из этого же репозитория | `main` | `v2-release`; fork с таким именем или другая base отклоняется |
| Обычная ветка, включая hotfix и main-sync | Прежний рабочий маршрут | `ordinary`; дополнительные ограничения v2 не вводятся |

Для задач v2 имя обязательно: например `codex/b02-v2-ci-guard`, `codex/ts02-toolchain`, `codex/c.funda.1-collector`. Guard распознаёт backlog ID, включая split-задачи; точный шаблон задан в `V2_TASK`. Он не определяет происхождение содержимого переименованной ветки или cherry-pick: соблюдение именования и проверка diff остаются обязательными. Разрешённый `v2-release` означает только корректный маршрут, а не разрешение выпуска или подтверждение единственности финального release PR.

Ветки задач создавать от актуальной `origin/codex/platform-v2`, последовательные зависимости сначала вливать туда. После начала совместной работы integration не force-push/rebase. `main` и production обновляются при отдельной финальной приёмке; B02 не переносится туда самостоятельно.

## Что проверяет workflow

`CI` запускается на push всех веток и PR (`opened`, `synchronize`, `reopened`, `edited`), включая смену base. Используется `pull_request` с `contents: read`; workflow не записывает в репозиторий и не использует `pull_request_target`.

`pr-target-guard` выполняет чистый `npm ci`, strict `npm run typecheck:ci`, проверку маршрута и merge-result. Для PR checkout остаётся стандартным `refs/pull/<number>/merge` с двумя уровнями истории: `HEAD` должен совпасть с `GITHUB_SHA`, иметь ровно двух родителей в порядке base SHA, head SHA из события. Номер PR и идентичности репозиториев также проверяются. В лог и job summary попадают тип PR, ветки, base/head SHA и проверенный merge SHA. Push не имеет PR merge ref: guard пропускает только PR-специфическую часть, затем запускаются остальные jobs.

Все пять существовавших jobs зависят от guard через `needs`, их проверки сохранены:

- `check`: чистые installs backend/admin, сборка admin, Prisma generate/migrate на PostgreSQL 17 сервиса CI, typechecks, unit/integration tests, backend build и schema validate.
- `application-image`: сборка приложения и проверка admin bundle/Prisma models в образе.
- `funda-image`, `huurwoningen-image`, `pararius-image`: сборка browser images и существующие проверки их runtime/profile.

Новый `tsconfig.ci.json` строго проверяет только TS guard и его тест. Он не закрывает общий перенос legacy scripts/tests и проверки TS02/TS08–TS11; `npm run typecheck` по-прежнему проверяет backend `src/**/*.ts`.

## Настройка защиты GitHub

Для `codex/platform-v2` требуются PR, одно approval с отклонением устаревших approvals при новых commits, strict status checks (ветка актуальна относительно base), применение правил к администраторам без bypass; force push и deletion выключены. Required checks от GitHub Actions: `pr-target-guard`, `check`, `funda-image`, `application-image`, `huurwoningen-image`, `pararius-image`. Выбирать существующие имена checks после их первого выполнения, не добавлять предполагаемые display names.

Для `main` сохраняется такой же review/strict/admin policy и пять существующих checks. Добавление required `pr-target-guard` отложено до появления workflow с этим job в `main`: иначе обычный hotfix мог бы ожидать check, который там ещё не создаётся. Перед финальным release проверить актуальные правила и добавить guard при появлении job; не обходить это переносом незавершённого v2 в `main`.

Проверять сохранённые правила в [GitHub branch protection](https://github.com/LordAsmodey/housing-monitor-nl/settings/branches), затем открывать правило повторно и сверять check names, источник GitHub Actions, approvals, strict/admin и запреты force/delete. При доступном авторизованном API можно прочитать их командой `gh api repos/LordAsmodey/housing-monitor-nl/branches/codex%2Fplatform-v2/protection` (для `main` заменить имя ветки). Ответ 403 или отсутствие CLI-авторизации не подтверждает отсутствие защиты: использовать доступный authenticated UI и фиксировать readback.

## Локальная проверка и доказательства

Для изменённого guard:

```sh
npm run typecheck:ci
node --import tsx --test test/ci-pr-target-guard.test.ts
npm run typecheck
npm test
npm run build:all
npm run db:validate
```

`ci:pr-target` и `ci:merge-result` читают событие из `GITHUB_EVENT_PATH` и контекст GitHub; обычный локальный запуск без них должен завершаться ошибкой. В hosted PR проверить job summary с base/head/merge SHA и все шесть checks на актуальном commit. Локальный тест с временным git merge проверяет CLI, но не заменяет выполнение GitHub Actions. БД интеграционных тестов должна быть отдельной; production `.env` не использовать.

## Статус B02 на 1 ноября 2026

- Код и тесты прошли независимое review. Подтверждены локально: 217 существующих unit tests, 29 проверок guard, `typecheck`, `typecheck:ci`, `build:all`, `db:validate`; CLI merge-result проверен на реальном merge во временном git-репозитории.
- Hosted CI подтверждён для [PR #49](https://github.com/LordAsmodey/housing-monitor-nl/pull/49): [run #276](https://github.com/LordAsmodey/housing-monitor-nl/actions/runs/41293671455) завершился успешно по всем шести checks от GitHub Actions (`app_id=15368`). Проверен head `b00f910b51dcb5b856b8593d7944fa64baf40973`; это SHA до последующего обновления документации, а не подтверждение будущего head.
- [Guard job](https://github.com/LordAsmodey/housing-monitor-nl/actions/runs/41293671455/job/124809949864) подтвердил `refs/pull/49/merge`, merge SHA `852442a32d84eb8987e5f45d83bd4355f5d6a716` и порядок родителей: base `7835efe35f75594a6089f13a206037b5d9539802`, head `b00f910b51dcb5b856b8593d7944fa64baf40973`. Родители дополнительно сверены через commit API.
- [Check job](https://github.com/LordAsmodey/housing-monitor-nl/actions/runs/41293671455/job/124810014544) подтвердил чистые installs, admin build, шесть миграций на PostgreSQL 17, оба typechecks, 246 unit tests, 39 DB integration tests, backend build и schema validation; failed/skipped — 0. Все четыре Docker build и runtime smoke прошли. UI не менялся: frontend review и продуктовый E2E пропущены.
- Защита `main` сохранена и повторно проверена: [правило 85658923](https://github.com/LordAsmodey/housing-monitor-nl/settings/branch_protection_rules/85658923), пять существующих checks и policy выше. API read вернул 403, `gh` не авторизован; использован authenticated GitHub UI.
- Защита integration с шестью checks подготовлена, но сохранение и readback ещё не подтверждены: GitHub требует повторную Mobile-аутентификацию. B02 полностью не закрыт; PR не слит, выпуск не выполнен.

Результаты B01 от 31 октября в [подготовке v2](plans/platform-v2-preparation.md) остаются отдельным историческим подтверждением и не доказывают CI текущего PR.
