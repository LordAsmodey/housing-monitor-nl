---
name: design-feature
description: "Процесс HTML/CSS дизайна Housing Monitor NL по явной команде design:, /design или $design-feature: Designer, Viewport Runner, Design Reviewer; основной агент только оркестрирует."
---

# Design Feature

Только явный вызов процесса. Обычная правка CSS, вопрос об архитектуре или
упоминание команды в примере не включают его. Сообщи о включении режима.

Прочитай `AGENTS.md`, `.codex/agent-context.md`,
`.codex/agents/orchestrator.toml` и раздел запуска `docs/subagents.md`.
Основной агент только координирует: не пишет HTML/CSS/README, тесты или план
и не исправляет результат сам. Используй все три профильные роли; наличие
всех 14 ролей в проекте не означает участие всех в design-only процессе.

## Процесс

1. Из запроса получи экраны, цель, референсы и требования. Выбери output folder
   `designs/<kebab-case-slug>/` либо заданный пользователем путь. Существенную
   неоднозначность уточни, прочее передай Designer как явные assumptions.
2. Designer получает feature/requirements, нужный стиль проекта и folder scope.
   Создаёт semantic responsive HTML/CSS + короткий README экранов/состояний.
   English для v2; не тащить игровую палитру или React/Next.js prototype.
3. Viewport Runner получает entrypoint/folder и размеры: 320x720, 768x1024,
   1024x768, 1440x900, если не заданы другие. Использует доступный browser/
   capture инструмент, сохраняет реальные изображения и revision evidence.
   Не предполагает отсутствующий scripts/viewport-screenshots.js. Без capture
   возвращает явный SKIPPED/BLOCKED, не устанавливает инструменты автоматически.
4. Design Reviewer получает feature, папку и свежие captures. Сначала проверяет
   требования/HTML/CSS, затем реальные изображения. Отчёт отдельно обозначает
   code review и visual evidence. Optional capture может дать code-only
   APPROVED с ограничением; обязательная визуальная приёмка без capture BLOCKED.
5. FAILED → Designer исправляет ту же папку → новые captures → новый review.
   Initial attempt + максимум три цикла исправления; счётчик не сбрасывать
   заменой агента. После исчерпания сообщи незакрытые критерии и остановись.
6. Итог: folder/files, экраны/состояния, review, реальные viewports, пропуски
   и assumptions. Prototype не означает рабочий API, Google или Telegram.

Передавай только релевантные выдержки и пути, absolute checkout и write scope.
Никаких личных данных/секретов в прототипах/captures. Изменения реального
приложения делает последующий implement workflow: `implement: <задача> —
дизайн в designs/<slug>/`. Не запускай реализацию автоматически.

Если именованная роль недоступна, общий субагент читает соответствующий TOML.
Если делегирование недоступно вообще, сообщи BLOCKED, не рисуй сам.
