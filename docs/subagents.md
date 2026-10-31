# Субагенты и явные команды

Все 14 ролей Cursor перенесены в проектные `.codex/agents/*.toml`.
Роли наследуют модель, разрешения и подключённые MCP основной сессии;
конфигурация не устанавливает MCP и не переключает модель. Read-only роли
ограничены инструкциями, отдельную sandbox-изоляцию TOML не создаёт.

## Два режима

**Обычный запрос:** основной агент работает как обычно, может сам менять код,
документы и запускать проверки. Большая задача сама по себе не включает pipeline.

**Явная команда:** основной агент принимает роль Orchestrator, только читает
нужный контекст, координирует, проверяет результаты и передаёт поручения.
Он не пишет/исправляет ни код, ни тесты, ни документы, ни конфиги/миграции,
ни прототипы, ни план реализации. Мелкий fix после review тоже делегируется.

```text
implement: <задача>
/implement <задача>
$implement-feature <задача>

design: <экраны и цель>
/design <экраны и цель>
$design-feature <экраны и цель>
```

`implement:`/`design:` и `/implement`/`/design` — текстовые соглашения в чате,
обрабатываемые `AGENTS.md`, а не обещание новых встроенных slash-команд UI.
Нативный вызов skill — `$implement-feature` / `$design-feature`, если skill
виден в текущем клиенте. Оба skill имеют `allow_implicit_invocation: false`.
Явные текстовые команды всё равно загружают SKILL.md через правило AGENTS.md.
Цитата, вопрос «как работает implement?» или пример не запускают процесс.
Отдельная команда `implement` или `design` без описания (также с `/`) берёт
однозначную задачу из диалога; при отсутствии такой задачи нужно уточнить цель.
Режим действует до завершения/отмены вызванного процесса; обычная следующая
задача не наследует запрет основному агенту писать код.

## Реестр

| Роль | Определение | Работа |
|---|---|---|
| orchestrator | [TOML](../.codex/agents/orchestrator.toml) | Основной агент: процесс и контроль, без создания артефактов |
| architect | [TOML](../.codex/agents/architect.toml) | Архитектура/контракты/миграция; только анализ |
| planner | [TOML](../.codex/agents/planner.toml) | Задачи, scope, DAG, критерии и порядок |
| backend-worker | [TOML](../.codex/agents/backend-worker.toml) | API, источники, DB, browser workers, tooling; Context7 |
| frontend-worker | [TOML](../.codex/agents/frontend-worker.toml) | Admin и v2 web; Context7 |
| backend-reviewer | [TOML](../.codex/agents/backend-reviewer.toml) | Независимое backend/source/DB review; только чтение |
| frontend-reviewer | [TOML](../.codex/agents/frontend-reviewer.toml) | Независимое UI/API/a11y review; только чтение |
| backend-tester | [TOML](../.codex/agents/backend-tester.toml) | Backend/source/DB тесты и fixtures |
| frontend-tester | [TOML](../.codex/agents/frontend-tester.toml) | UI сценарии, browser/build/component evidence |
| e2e-tester | [TOML](../.codex/agents/e2e-tester.toml) | Интегрированные local/staging сценарии |
| designer | [TOML](../.codex/agents/designer.toml) | HTML/CSS прототипы и описание состояний |
| viewport-runner | [TOML](../.codex/agents/viewport-runner.toml) | Реальные captures, размеры и revision evidence |
| design-reviewer | [TOML](../.codex/agents/design-reviewer.toml) | Проверка прототипа и captures; только чтение |
| docs-writer | [TOML](../.codex/agents/docs-writer.toml) | Профильные runbooks, ADR и навигация |

## Процессы

Implement: optional Architect → обязательный Planner → по каждой задаче
Worker → matching Reviewer → frontend-tester → backend-tester → e2e-tester →
docs-writer → итог. Каждый Tester вызывается; отсутствие своего scope даёт
обоснованный SKIPPED, обязательная непроверенная часть — BLOCKED.

Design: Designer → Viewport Runner → Design Reviewer → итог. После правки
Designer нужны новые captures. Реализация приложения — отдельный вызов implement.

Initial attempt + до трёх циклов исправления; task review, test phase и design
имеют отдельные счётчики. Frozen prerequisite блокирует зависимые задачи.
Подробности: [implement skill](../.agents/skills/implement-feature/SKILL.md),
[execution](../.agents/skills/implement-feature/references/execution.md),
[verification](../.agents/skills/implement-feature/references/verification.md),
[design skill](../.agents/skills/design-feature/SKILL.md).

## Запуск в Codex и совместимость

Codex читает проектные роли из `.codex/agents/`, skills из `.agents/skills/`.
Если новые определения не появились в уже открытом клиенте, обнови контекст
проекта/начни новый чат; при необходимости перезапусти клиент. Repository
config должен быть доверенным по правилам установленного Codex. Managed
ограничения и доступная конкуренция имеют приоритет над пожеланиями workflow.

Используй доступный native API выбора именованной роли, если он есть. Некоторые
среды предоставляют только `spawn_agent(task_name, message, fork_turns, ...)`:
`task_name` — имя задачи, само по себе оно не загружает custom agent. В таком
случае явно поручай общему субагенту прочитать
`<checkout>/.codex/agents/<role>.toml`, выполнить `developer_instructions`,
прочитать общий контекст и передай минимальный пакет задачи. Не выдумывай
параметр `subagent_type`/`agent_type`, если его нет в схеме инструмента.

Предпочитай новый компактный контекст (`fork_turns: "none"`, когда доступен),
не передавай всю историю. Model override не нужен. Followup возвращает работу
той же роли; messaging только передаёт уточнение; wait/interrupt — по реальным
возможностям среды. Не создавай пользовательские чаты вместо субагентов.
При отсутствии делегирования workflow BLOCKED, сам Orchestrator не реализует.

Изоляция checkout/ресурсов обязательна до записи. Для v2 каждый task получает
точные base ref/SHA, branch, абсолютный checkout и PR target `codex/platform-v2`;
prerequisites сначала интегрируются. Общие schema/lockfile/contracts имеют
одного владельца; независимые задачи параллельны только в пределах слотов.

## Context7, версии и требования

Workers обязаны использовать подключённый Context7: resolve ID → query docs
для конкретного API и установленной версии. Фактические lockfiles важнее
latest примера. При недоступности нужен явный fallback на официальные docs/
typings; при невозможности проверить критичный API — BLOCKED. MCP наследуется
от основной сессии, API keys в Git не нужны. Без подключения Context7 нельзя
утверждать, что проверка им выполнена. Автообновления зависимостей не включены.

Стек, текущие/будущие пути, указатели констант, v2 лимиты и инварианты —
[общий контекст](../.codex/agent-context.md). Требования/расхождения v1/v2 —
[индекс](index.md), профильный Notion, [план](plans/multi-user-platform-v2.md)
и [подготовка](plans/platform-v2-preparation.md). Этот набор инструкций не
внедряет саму платформу v2 и не закрывает A01 или staging acceptance.

Формат/загрузка: [OpenAI — Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents),
[Build skills](https://learn.chatgpt.com/docs/build-skills). Поведение конкретного
клиента/сессии проверяй по реально доступным инструментам.
