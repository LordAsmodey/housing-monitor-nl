# Проверки и ограниченные циклы исправления

## Фаза тестирования

После реализации на интегрированном candidate вызови последовательно:

1. frontend-tester — frontend задачи, UI states/design и критерии;
2. backend-tester — API/source/DB задачи и контракты;
3. e2e-tester — сквозные сценарии и общие границы, candidate SHA.

На начальном проходе каждая роль выдаёт результат, даже если scope пустой.
Пустой scope → SKIPPED с причиной. Нужная инфраструктура недоступна → BLOCKED,
не PASSED. Если ранний сбой делает позднюю проверку бессмысленной/небезопасной,
передай позднему Tester причину для BLOCKED, а не запускай заведомо неверную среду.

Реальные команды брать из checkout. В исходном проекте: npm run typecheck,
npm test, npm run build:all, npm run db:validate; DB integration отдельно.
Обязательные CI jobs — текущая .github/workflows/ci.yml, включая Docker images.
Тестировщик отмечает проверки, оставленные CI, и недостающую среду. Не требуй
production/live checks для изменения только инструкций/документации.

PostgreSQL integration запускай только с доказанно отдельной test DB, явно
заданным DATABASE_URL и нужными миграциями. Изолируй Sentry, Telegram и внешние
источники. E2E с Google/Telegram — только выделенный staging/test scenario.
Наличие .env или имени branch не доказывает безопасность назначения.

В отчёте каждой проверки: PASSED/FAILED/BLOCKED/SKIPPED, command/exit code,
counts/assertions, environment и scope. Сборка не заменяет browser E2E;
мок linking не доказывает реальную авторизацию. Обязательная непроверенная
часть не допускает общего «всё прошло».

## Счётчики без двусмысленности

Для task review `task_reworks[id] = 0` — число **уже выполненных циклов
исправления**, начальная реализация в это число не входит.

```text
initial Worker → Reviewer
while review == FAILED:
    if task_reworks[id] == 3: freeze task; stop this branch
    task_reworks[id] += 1
    Worker fixes findings → Reviewer
```

Итого максимум 1 начальная реализация + 3 исправления, 4 review результата.
Замена агента или дополнительный test feedback не обнуляют task counter.
Если review после test feedback провалился, действует оставшийся task budget.

У test phase отдельный `test_reworks = 0`, тоже число выполненных циклов:

```text
initial test phase
while a required test == FAILED:
    if test_reworks == 3: stop test rework; report failed acceptance
    test_reworks += 1
    affected Worker fixes → matching Reviewer approves
    re-run affected tests plus integration/regression justified by changes
```

Если ошибка в тесте, исправляет Tester, затем matching Reviewer проверяет
тестовый diff и Tester повторяет проверку. Orchestrator сам тест не переписывает.
Не перезапускай неизменившийся полный suite без новой причины. Сохраняй ранее
полученные результаты только пока они применимы к текущему candidate.

Для design review такой же предел: initial Designer/capture/Reviewer + до
3 исправлений. После любого HTML/CSS исправления captures снимаются заново.

## Остановка и зависимости

- Freeze task после исчерпания review budget; не запускай его descendants.
  Продолжать можно только независимые задачи и безопасные проверки.
- BLOCKED из-за среды/контракта не лечится слепыми повторными запусками Worker.
  Сообщи, чего не хватает, и выполни независимую разрешённую работу.
- Контрактное противоречие верни Architect, проблему плана — Planner,
  production defect — Worker, test defect — Tester, docs — docs-writer.
- Недоступна custom role: общий субагент читает её TOML. Недоступно само
  делегирование: workflow BLOCKED, без самостоятельной реализации Orchestrator.
- Итог содержит реальные причины, незакрытые критерии, counts попыток и
  следующий конкретный шаг. Лимит попыток не превращает неудачу в успех.
