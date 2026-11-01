# Выполнение и передача контекста

## Подготовка и роли

Orchestrator читает task-related контекст и проверяет реальные файлы, но не
создаёт план/архитектуру вместо Planner/Architect. При недостатке контекста
сначала использует доступный адресный поиск, затем задаёт существенный вопрос.

Для каждой изменяемой задачи укажи branch, абсолютный checkout, integration
base ref/SHA и target PR. V2: свежий `origin/codex/platform-v2`; prerequisites
должны быть интегрированы перед стартом зависимой task branch. Не создавай
промежуточные PR в main. Не включай чужие локальные изменения и secrets.

Изолированный checkout для изменяемой task branch; Reviewer смотрит именно
его diff. Если среда даёт всем агентам один filesystem, это не изоляция:
используй worktree tooling, проверь разрешения и дай абсолютный путь каждому.
Не делегируй запись до готовности checkout. Интеграцию Git/PR выполняет
Orchestrator в рамках поручения; ручные конфликты исправляет Worker, затем
Reviewer и Testers перепроверяют изменённый результат. Merge/release — по
разрешениям текущей задачи; команда не разрешает production rollout сама собой.

## Минимальный пакет поручения

Передавай по роли только необходимые поля:

```text
role: backend-worker
task: <ID, цель, описание>
checkout: <абсолютный путь>; task branch: <ветка>
integration base: origin/codex/platform-v2 @ <проверенный SHA>
PR target: codex/platform-v2
requirements: <URL + раздел/дата + существенная выдержка>
contracts/prerequisites: <принятые версии/зависимости и их состояние>
write scope: <конкретные пути>; read pointers: <нужные файлы/символы>
acceptance criteria: <проверяемые результаты>
verification/environment: <команды и отдельная test/staging среда>
expected output: <файлы/решения/evidence/exit codes/ограничения>
```

Не передавай всю историю чата, длинные логи или полные документы всем ролям.
При минимизации не теряй source-specific фильтры, ограничения доставки,
статус предложений и ошибки. Свежие выдержки Context7/Notion передавай с
версией/URL; повторное чтение нужно только при новом вопросе/изменении.
Credentials передаются защищённой конфигурацией среды, не текстом поручения.

## Architect → Planner

Architect вызывается при существенном архитектурном выборе: новые API/flows,
ownership, schema/events/migrations, process boundaries. Для маленькой задачи
в рамках существующего контракта может быть пропущен, даже в implement mode.
Передай feature, requirements, existing pattern pointers и ограничения v2.
Получай contracts/risks/constraints_for_orchestrator, не task plan.
CONFLICT/NEEDS_INPUT требует решения, а не молчаливого обхода.

Planner всегда получает feature + нужную архитектуру/контракты + optional
design folder. Проверь его результат:

- Все tasks имеют ID, непустой точный scope, существующего assignee из реестра,
  acceptance criteria, expected output и проверки.
- depends_on содержит существующие IDs, DAG без циклов; prerequisites готовы.
- Параллельные scopes/ресурсы независимы; schema/contracts/lockfiles/bootstrap
  имеют одного владельца. Тестовые пути и integration task явно учтены.
- Не создаётся логика на JS/CJS/MJS; TS перенос сохраняет поведение.
- Каждый frontend task с дизайном ссылается на нужную папку.

Невалидный план отправь Planner с конкретными замечаниями. Не исправляй сам.

## Worker → Reviewer

Worker получает одну задачу и релевантную архитектуру. Использует Context7
для библиотечных API по версии проекта, сообщает DONE/BLOCKED/NEEDS_SCOPE.
Новые пути/изменение контракта возвращаются Planner/Architect, не добавляются
Orchestrator или Worker молча.

Reviewer получает тот же scope/критерии, точный base/candidate diff и evidence.
Соответствие: backend-worker → backend-reviewer; frontend-worker →
frontend-reviewer. Для cross-domain task Planner должен определить оба review.
После parallel group дождись всех исполнителей и проверь их actual paths,
затем выполняй reviews. Worker и его Reviewer — разные агенты.

FAILED → тот же исполнитель с findings → повторный независимый review.
APPROVED помечает task done только после сверки actual результата. BLOCKED
не запускает бессмысленный code-rework при отсутствующей среде/контракте.

Плановые проверки своего кода Worker может выполнять; это не заменяет Testers.
Основной Orchestrator проверки приложения сам не запускает.

## Testers → docs → отчёт

Testers получают feature, relevant tasks/criteria, candidate SHA и отдельные
test paths/environment. Они проектируют/пишут/выполняют тесты; зависимости и
application config исправляют Workers. Каждый изменённый тест проходит
matching Reviewer; после review-правки повторяются затронутые проверки.
Для frontend tests назначай frontend-reviewer, для backend/source/DB tests —
backend-reviewer. Для E2E test scope при передаче поручения явно назначай
frontend-reviewer и/или backend-reviewer по затронутым контрактам; сквозной
UI/API тест проверяют оба. Выбор Reviewer не перекладывается на автора теста.
Не допускай смены смысла теста ради успешного результата.

Docs-writer получает завершённые и незавершённые задачи, actual diff/files,
contracts/ADR и test results. Он обновляет только нужные docs или возвращает
SKIPPED. После неуспеха описывает реальные ограничения, не готовность feature.
Если docs обязательны критериями и агент недоступен, это BLOCKED.

Итог: task outcomes/frozen/dependencies, критерии, frontend/backend/E2E
results с границами, docs, Context7/fallback summary, candidate SHA, PR base,
оставшиеся действия. При создании PR прикрепи его к текущему чату.
