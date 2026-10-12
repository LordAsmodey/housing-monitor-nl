# Ручная проверка Funda в браузере Railway

Временный сервис funda-browser-session открывает стандартный headed Chromium 141
в Railway us-west2 и предоставляет мобильную страницу управления его экраном.
Сервис отдельный от приложения, БД и Telegram. Он используется для ручной проверки
человека и последующей проверки доступа в той же браузерной сессии.

## Пользовательский поток

1. Агент передаёт приватную одноразовую ссылку. Открыть её в обычном браузере телефона.
2. Нажимать на изображение Funda, прокручивать кнопками и при необходимости вводить текст
   через поле под экраном. Масштаб страницы можно увеличить двумя пальцами.
3. Пройти проверку Funda вручную и нажать «Сохранить сессию».
4. Сообщить агенту результат. Агент читает runtime-логи, затем проверяет доступ после
   перезапуска сервиса с восстановленным состоянием. Команды в консоли пользователя не нужны.

«Проверить поиск» открывает согласованный URL Groningen +30 км, до €1500,
с сортировкой по дате, в том же контексте. Наличие карточек здесь означает доступ к поиску;
это ещё не проверка нормализации, 72-часового фильтра и полной Telegram-доставки.

## Защита и сохранение

- Доступ по случайному ключу; ключ находится в URL fragment, поэтому не передаётся
  в HTTP URL, access logs или Referer. Страница убирает fragment после чтения.
- При первом входе ключ обменивается на HttpOnly/Secure/SameSite=Strict cookie.
  Повторный обмен по ссылке закрыт, но уже установленная cookie работает до срока окончания.
- Все снимки экрана и операции браузера требуют действительную подписанную cookie.
  POST проверяет точный Origin; внешний сайт не может управлять браузером.
- Никакого открытого VNC, CDP, Playwright WebSocket или API выполнения JavaScript.
  API принимает только ограниченный набор кликов, клавиш, прокрутки и двух URL Funda.
- Storage state сохраняется в /data/browser-state.enc с AES-256-GCM и случайным nonce;
  ключ шифрования находится только в переменной Railway. Файл записывается атомарно
  с правами 0600. Cookies, localStorage и IndexedDB не выводятся в логи и HTTP API.
- Сервис закрывается по абсолютному времени окончания доступа, restart policy NEVER.
  Состояние на volume остаётся зашифрованным. Удаление ресурса/данных выполняется отдельно.

## Конфигурация сервиса

Исходный сценарий: [funda-browser-session.cjs](../scripts/funda-browser-session.cjs).
Образ: mcr.microsoft.com/playwright:v1.56.1-noble. Сценарий устанавливает соответствующий
Playwright 1.56.1, запускает Xvfb, затем обычный Chromium. Нет stealth, proxy,
подмены fingerprint, автоматического входа или решения CAPTCHA.

Переменные только этого сервиса:

- PORT=8080.
- BROWSER_PUBLIC_ORIGIN — точный публичный HTTPS origin.
- BROWSER_ACCESS_KEY — случайный приватный ключ доступа, минимум 32 символа.
- BROWSER_STATE_KEY_HEX — 32-байтовый ключ шифрования в hex.
- BROWSER_ACCESS_EXPIRES_AT — абсолютное ISO время окончания.

Приватные значения и ссылки доступа никогда не коммитятся и не добавляются в Notion.
Volume монтируется в /data. Для повторного одноразового доступа после потери cookie нужен
новый ключ и сброс маркера /data/link-consumed; ключ шифрования состояния следует сохранить.

## Проверка запуска

Railway production service `e8bbb399-25db-4e94-ae24-cd4935d3ac2f`, volume
`1c1b7956-37dc-4eb8-a99b-b55169e9a691` (500 MB), регион us-west2.
Deployment `44af4d53-a6c8-412e-81f2-d800f9f0f75d` завершился SUCCESS.
В логах 12 октября 2026 года подтверждены:

- browser-ready: restored=true, Chromium 141.0.7390.37 — зашифрованное состояние
  первоначального запуска восстановлено после редеплоя.
- page-state: humanCheck=true, accessDenied=false, listingLinks=0 — показана проверка Funda.
- server-ready: без авторизации экран возвращает 401, чужой Origin — 403,
  неправильный ключ — 401.
- mobileUi=true, screenshotWidth=1024: отдельный тестовый контекст Chromium с мобильным
  экраном 390×844 проверил JavaScript интерфейса и загрузку изображения. Одноразовый ключ
  пользователя в этом тесте не использовался и не был погашен.

Локально четыре теста проверили аутентифицированное шифрование/повреждение состояния,
подделку и срок cookie, ключ/Origin и ограничения API действий.

## Границы текущей проверки

Пользователь прошёл ручную проверку и подтвердил сохранение сессии. После этого агент
дважды открыл фиксированный поиск через защищённый API в том же контексте:
08:04:50 и 08:04:58 UTC — HTTP API 200, humanCheck=false, accessDenied=false,
listingLinks=33. Это число ссылок DOM, а не 33 уникальных подходящих объявления.

Затем агент перезапустил браузерный сервис с тем же зашифрованным volume. В 08:07:38 UTC
лог подтвердил restored=true; в 08:07:40 UTC — снова поиск, humanCheck=false,
accessDenied=false, listingLinks=33. Повторная ручная проверка не потребовалась.
Мобильный UI и защита маршрутов повторно прошли startup self-check после перезапуска.
Verifier: [funda-session-verify.cjs](../scripts/funda-session-verify.cjs), deployment
`52653713-9b1a-4b50-8aa4-3ebdb2090f74`, использует краткоживущую подписанную capability
для UI API; cookie Funda и файлы browser state ему не передаются.

Storage state не является полным persistent browser profile: sessionStorage и некоторые
свойства браузерной сессии не восстанавливаются автоматически. Привязка проверки к IP
также возможна. Тест подтвердил допуск после одного перезапуска в течение нескольких минут;
длительный мониторинг, повторное истечение допуска и смена исходящего IP не проверены.
Production-монитор ещё использует исходный HTTP Fast Path: браузерный executor и передача
ему сохранённой сессии в этой задаче не подключались.

Runtime пишет только начало подключения и сводку текущей страницы: заголовок, путь,
признак проверки человека, отказа и число ссылок карточек. Ввод пользователя, секреты,
screenshots и значения browser state в логи не попадают.

## Persistent monitoring and manual recovery

The browser service can now run continuously with BROWSER_WORKER_TOKEN set. Its
worker API accepts a separate server credential, serializes collection and human
operations, and returns normalized listings, never cookies. The existing encrypted
volume and BROWSER_STATE_KEY_HEX must be retained. Expiry closes human access only;
the collector continues. The Nest scheduler uses FUNDA_BROWSER_ORIGIN and
FUNDA_BROWSER_TOKEN (a Railway reference to the browser service credential), with
no monitor enable flag. Switching from HTTP schedules the first browser check
without waiting for the previous six-hour block cooldown.

A blocked collection retains baseline and last success. A recovery episode creates
one durable Telegram outbox alert containing an explicit, one-use browser access
link with a 24-hour expiry. The grant is encrypted on the browser volume and
survives restart. Do not forward the link. The user completes the challenge,
opens “Поиск жилья” and clicks “Сохранить сессию”. The scheduler sees that recovery
and schedules a fresh validated collection. Other normal notification delivery
continues through the bot-wide durable gate. No fake housing listing is created
for administrative alerts; listingId is nullable for these outbox entries.

Recovery links are privileged, short-lived capabilities intentionally delivered to
the configured Telegram group at the user's request. Never include their values,
worker tokens, encrypted state keys or cookies in Git, Notion or logs.

The live parser reads coordinates from the indexed __NUXT_DATA__ array when JSON-LD
omits them. Unknown or ambiguous coordinates remain an error. Listings marked
Onder bod are excluded alongside rented/under-option homes. Browser collection has
a five-minute deadline under a six-minute database lease; HTTP retains its shorter
budget. Dockerfile.browser packages the matching Playwright version for a
reproducible browser-service build.

For repository-backed browser deployments, select railway.browser.json as that
service's config path (the main service keeps railway.json). This selects the
browser Dockerfile and /health without running the application's database migration
command inside the browser image. Keep one replica and the existing /data volume.
The temporary inspection endpoint used during research is removed from the final
worker; only state, collection and recovery-grant API routes are retained.

The 1 GB research container approached its memory limit during repeated detail
navigation (observed peak 0.990 GB) and later stopped serving page reads. The worker
now exits on renderer crash or browser disconnect so Railway restores the encrypted
session under its ON_FAILURE policy. Production browser memory is raised to 2 GB.
During collection only, property photos from cloud.funda.nl are not loaded; page
scripts, styles and manual human-check resources remain enabled. Human operations
load normal images. Heartbeats do not accumulate while a collection is running.

A live legacy P.C. Hooftlaan detail page omits Status entirely. An explicit public
publication older than the requested 72-hour window now excludes that card before
availability/geo/rent validation. Fresh or undated cards retain strict validation;
unknown freshness or availability never becomes a successful empty result. The
versioned browser scenario reference schedules one check when the recipe changes.
