# Funda: browser worker и ручное восстановление

[Требования](https://app.notion.com/p/402d10c6e6ab8195868de764fcdce855?pvs=204) · [Текущий поиск и контракт](funda.md)

Worker использует отдельный Chromium/Playwright и шифрованное состояние на своём
volume `/data`. Исходник — `scripts/funda-browser-session.cjs`,
Dockerfile — `Dockerfile.browser`, команда запуска — `node scripts/funda-browser-session.cjs`.
Не копировать исполняемый код в Railway Start Command. Параметры сервиса задаются
отдельно от приложения: healthcheck `/health`, пустой pre-deploy, одна реплика.
При выпуске сверять действительную конфигурацию сервиса: [Railway](railway.md).

## Конфигурация

- `PORT` — порт HTTP-сервера (в образе 8080).
- `BROWSER_PUBLIC_ORIGIN` — точный публичный HTTPS origin.
- `BROWSER_WORKER_TOKEN` — отдельный серверный credential для collector API.
- `BROWSER_STATE_KEY_HEX` — 32-байтовый ключ шифрования в hex.
- `BROWSER_ACCESS_KEY` и `BROWSER_ACCESS_EXPIRES_AT` — временный человеческий доступ.
- `FUNDA_BROWSER_ORIGIN` и `FUNDA_BROWSER_TOKEN` — переменные основного приложения.

Сохранять volume, ключ шифрования и Source ID при рестарте/выпуске. Истечение
человеческого доступа не должно останавливать collector. Cookies и состояние не
возвращаются через worker API. Human operations и сбор сериализованы.

## Восстановление

При блокировке baseline и последний успех сохраняются. Recovery episode создаёт
durable admin alert в Telegram с одноразовой ссылкой на защищённый интерфейс.
Ссылка — привилегированный временный доступ; не копировать её в Git, Notion или логи.

Пользователь открывает ссылку, проходит обязательную проверку, открывает «Поиск жилья»
и нажимает «Сохранить сессию». Scheduler видит восстановление и запускает новую
валидированную проверку. Страница поиска использует тот же SEARCH_URL, что collector.

При действующей HttpOnly cookie повторное открытие ссылки использует существующую
сессию. Использованный ключ без действующей cookie не даёт доступ. Для нового grant
используется авторизованный `POST /worker/recovery/renew`; обычный recovery endpoint
сам по себе не гарантирует выдачу новой ссылки. Ключи и recovery-ссылки передавать
только через предусмотренный закрытый канал.

## Проверка и диагностика

Сначала различать ошибку входа в recovery UI (например, 401 /api/login) и блокировку
самой Funda. Вход в UI, валидный поиск, полный сбор и доставка — разные подтверждения.
При изменении worker проверять затронутые тесты browser session/client/recovery UI,
Docker-сборку и, если этого требует выпуск, read-only полный сбор.

Общие лимиты, rate limits, URL allowlists и защита секретов сохраняются. Ошибка или
human-check не превращаются в успешный ноль. [Idle/ресурсы](browser-optimization.md).

[История экспериментов, прежних bootstrap-команд и production-проверок](archive/funda-browser-history.md)
не является инструкцией повторного развёртывания.
