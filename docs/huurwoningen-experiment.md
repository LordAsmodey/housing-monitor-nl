# Huurwoningen: production Chrome worker and completed Patchright trial

The Patchright service reads the exact existing Groningen search and has no direct database or Telegram access.
By explicit user decision on 13 October 2026, the production application uses this worker.
The trial was accepted by the user on 14 October; its observer is disabled with
`BROWSER_EXPERIMENT_ENABLED=false`. The existing Source ID, baseline and transactional outbox are retained.
The old Playwright browser is retained as a separate fallback; it is not used for scheduled Huurwoningen collection.

Runtime: Patchright 1.63.0, Google Chrome, headed persistent context, no user-agent injection,
no viewport emulation. Chrome's complete profile lives in ephemeral `/tmp`; only an authenticated-encrypted
archive is saved to the dedicated `/data` volume. Archive checkpoints happen after a graceful browser close
so SQLite databases are consistent. Cache and process locks are excluded. A hard crash can lose the latest
profile checkpoint; encrypted storageState cookies are a fallback, not proof of full profile restoration.
Allow 60 seconds of Railway draining for graceful close and archive creation.

## Build and deploy

For GitHub deployments, connect the service to `LordAsmodey/housing-monitor-nl`, branch `main`,
with repository root `/`. Set its Railway Dockerfile path to `Dockerfile.huurwoningen-experiment`,
start command to `node scripts/huurwoningen-patchright-session.cjs`, empty pre-deploy commands,
healthcheck `/health` (180 seconds), ON_FAILURE (3 retries), and draining 60 seconds.
The application separately uses `Dockerfile`, `/health/ready` and `npm run db:deploy`.
Do not add a root `railway.json`: it overrides service-specific settings and builds the wrong image
for the browser. Railway API rejects new custom Config File paths as deprecated; a future full IaC
migration is separate from these persisted service settings. The image writes Railway's
`RAILWAY_GIT_COMMIT_SHA` to `/app/REVISION` and rejects a missing or invalid SHA.
See [Railway build arguments](https://docs.railway.com/builds/dockerfiles) and
[Git metadata](https://docs.railway.com/variables/reference).
Verify `/health.release` against the merged commit, `profileRestored=true`, authenticated
`/worker/state` (`humanCheck=false`, `searchReady=true`), a normal production source run and the Telegram outbox.
Keep the same service, encrypted volume and variables when changing the deployment source.

PR #18 was merged on 14 October as `3ca80d7`. Both services are connected to `main`.
The first GitHub browser deployment built the application's image because root `railway.json`
overrode the browser Dockerfile path, and failed startup. Working browser deployment
`6bff73b9-85b4-44e5-b9c5-1590c852ff95` restored release `ece1467`, the full profile and validated
12 listings without a human challenge. Merge the config-removal fix before the next GitHub browser
deployment; verify the actual build uses the Chrome Dockerfile and `/health.release` matches the merge.

For a manual emergency deployment, commit all intended files, then export a whitelist directly from that commit:


```
node scripts/prepare-huurwoningen-experiment.cjs /tmp/housing-patchright-release
railway up /tmp/housing-patchright-release --path-as-root --detach --project <project-id> --environment production --service <experiment-service-id>
```

The artifact contains no .env, Git directory, production data or credentials. It includes a REVISION
file checked at startup and returned by /health, a Dockerfile and pinned npm lockfile. Chrome is installed
at image build time; its actual version is logged. A Railway redeploy of a CLI-uploaded artifact may rebuild the image and reinstall Chrome; verify its version again.
For a process-only restart, run `railway restart --service <experiment-service-id> --yes` from a directory
explicitly linked to the experimental project/environment. This service uses a normal Node command, without eval or code copied into Start Command.

Configure independent BROWSER_WORKER_TOKEN, BROWSER_STATE_KEY_HEX, BROWSER_ACCESS_KEY,
BROWSER_ACCESS_EXPIRES_AT and BROWSER_PUBLIC_ORIGIN. Generate a public domain for human recovery.
Never publish keys, cookies or recovery links in Git, Notion or logs.

Optional proxy variables: BROWSER_PROXY_SERVER (http/https/socks5 URL without inline credentials),
BROWSER_PROXY_USERNAME and BROWSER_PROXY_PASSWORD. Use a provider's sticky/static session configuration
so the exit IP stays constant during a browser session. No proxy is enabled or purchased by default.

## Trial gate

The following observer behavior applies only when `BROWSER_EXPERIMENT_ENABLED` is not `false`.

The worker attempts the existing fully validated collection every 15 minutes for 24 hours.
/data/experiment.json stores only timestamps, counts, safe categories and restart evidence.
GET /worker/experiment returns the report with worker authentication.
POST /worker/experiment/start explicitly starts/resumes the test; resuming a failed trial starts a fresh window.
A successful manual Save also restarts a paused trial. CAPTCHA stops automatic navigation immediately;
no solver or automated checkbox is used. POST /worker/recovery/renew issues a human access link.

Only 96 successful collection slots, no missed intervals and at least one confirmed full profile restoration
across a process restart can produce passed. Restart before the next scheduled slot using the same build;
confirm profileRestored=true in /health and restoredRestarts>=1 in the authenticated report.
A blocked or failed report is not a completed soak, and process liveness is not evidence of website access.

If the unproxied Railway trial is blocked, ask for proxy credentials/budget before testing paid egress.
The user authorized production Telegram delivery before the 24-hour trial completed.
Production owns the 15-minute schedule and listing deduplication; the observer performs additional read-only
collections through the same serialized browser queue. Only new listings relative to the existing baseline
can generate Telegram notifications; observer collections never send notifications directly.
Configure application HUURWONINGEN_BROWSER_ORIGIN with the Patchright service origin and
HUURWONINGEN_BROWSER_TOKEN as a Railway reference to its BROWSER_WORKER_TOKEN. After verifying
collection with the new worker and deployment configuration, release the previous BLOCKED state
conditionally (no active lease), without modifying baselineAt or stored listings.
If rollback is needed, restore the previous origin and token reference; preserve the source history.

## Completion accepted by the user — 14 October 2026

The user accepted the result after 95 consecutive successful observer checks, a confirmed full-profile
restoration across restart, healthy production collection and successful Telegram delivery. This is
user acceptance before the original 96-check/24-hour gate, not a claim that the automatic gate passed.
Set `BROWSER_EXPERIMENT_ENABLED=false` to disable the independent observer and its endpoints;
the same Chrome worker remains connected to the production 15-minute scheduler and outbox.
The final observer report is retained on the encrypted-state volume, alongside completion metadata.
The hourly Codex follow-up is paused. Credentials, baseline, listing history and notification deduplication
are preserved. The normal browser UI no longer displays the experiment label when disabled.
