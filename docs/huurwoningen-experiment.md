# Huurwoningen: isolated Patchright trial

The experimental service reads the exact existing Groningen search. It never connects to PostgreSQL,
the production scheduler or Telegram. The production browser, source ID, baseline and outbox stay in place.

Runtime: Patchright 1.63.0, Google Chrome, headed persistent context, no user-agent injection,
no viewport emulation. Chrome's complete profile lives in ephemeral `/tmp`; only an authenticated-encrypted
archive is saved to the dedicated `/data` volume. Archive checkpoints happen after a graceful browser close
so SQLite databases are consistent. Cache and process locks are excluded. A hard crash can lose the latest
profile checkpoint; encrypted storageState cookies are a fallback, not proof of full profile restoration.
Allow 60 seconds of Railway draining for graceful close and archive creation.

## Build and deploy

Commit all intended files, then export a whitelist directly from that commit:

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
Do not switch the production application to this worker until the trial passes and the rollout is authorized.
