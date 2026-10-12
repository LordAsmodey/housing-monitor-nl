# Huurwoningen

Согласованный поиск: <https://www.huurwoningen.com/in/groningen/?radius=25&available_from=within_3_months>.
`available_from=within_3_months` — «Beschikbaar vanaf → Binnen 3 maanden»: доступность для заселения в ближайшие три месяца. Это не свежесть публикации и не срок договора.
Радиус — 25 км. Дополнительного ограничения цены, даты публикации или типа жилья нет; комнаты, студии и woningruil остаются в выдаче.

Постоянный headed Playwright использует отдельный сервис, volume и ключ AES-256-GCM.
Сессия Funda не используется. Сбор читает только карточки и ссылки пагинации из выдачи,
проверяет отображение фильтров, полноту относительно общего числа результатов и отсутствие повторов.
Пределы: 20 страниц, 600 объявлений, 5 МБ HTML на страницу; превышение — ошибка, а не частичный успех.
Необязательная дата публикации не извлекается из отдельных карточек. Доступность карточки сохраняется как `unknown`: фильтр даты заселения не подтверждает статус конкретного объекта.

Source ID: `huurwoningen:groningen-25km-within-3-months`. Первый успешный сбор создаёт собственный baseline без рассылки.
Новые объявления затем проходят существующий transactional outbox в ту же Telegram-группу.
Проверка каждые `MONITOR_INTERVAL_SECONDS` (900 по умолчанию); lease в PostgreSQL защищает от overlap и повторного baseline.
Изменение цены/доступности и совпадения с Funda пока не создают отдельных событий.

## Включение

В приложении задаются обе переменные `HUURWONINGEN_BROWSER_ORIGIN` и `HUURWONINGEN_BROWSER_TOKEN`.
Без них источник выключен. Origin допускает только HTTPS `*.up.railway.app` или HTTP `*.railway.internal`;
токен отдельный от Funda и совпадает с `BROWSER_WORKER_TOKEN` нового сервиса.

Контейнер: `Dockerfile.huurwoningen-browser`. Для pinned official Playwright image start command
генерируется `node scripts/huurwoningen-browser-bootstrap.cjs`; он содержит только версионированный код.
Настройки worker аналогичны Funda: `BROWSER_PUBLIC_ORIGIN`, `BROWSER_ACCESS_KEY`, `BROWSER_ACCESS_EXPIRES_AT`,
`BROWSER_STATE_KEY_HEX`, `BROWSER_WORKER_TOKEN`, volume `/data`, healthcheck `/health`, память 2 ГБ.
Ключи, cookies и ссылки доступа не сохраняются в Git, Notion или логах.

CAPTCHA/HTTP 401/403 переводят источник в BLOCKED. Один recovery alert на эпизод приходит через outbox.
В браузере пользователь проходит проверку, нажимает «Поиск жилья», затем «Сохранить сессию».
Возобновление требует валидной выдачи; корректный нулевой результат тоже принимается.
Обязательные проверки человека автоматически не решаются. Авторизация для чтения публичной выдачи при первоначальной проверке не понадобилась.

## Проверки

`node --test test/huurwoningen.test.mjs` проверяет fixture реальной карточки, сохранение фильтров,
пагинацию, неполную выдачу, CAPTCHA и ограничения. Полный CI также проверяет две независимые базы объявлений,
baseline, lease, дедупликацию уведомлений и recovery на disposable PostgreSQL.

Первоначальная live-проверка 12 октября 2026: HTTP 200, 198 объявлений, 7 страниц;
публичная карточка содержит цену, площадь, комнаты и JSON-LD. Итоговый smoke собирает все страницы через worker.
