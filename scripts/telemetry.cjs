'use strict';
// Shared by NestJS, source runners and standalone browser services.
const path = require('node:path');
const SOURCES = new Set(['funda', 'huurwoningen', 'woldring', 'vesteda', 'gruno', 'lamberink', 'vandermeulen', 'maxx', 'rentola', 'pararius', 'solide', 'gohome', 'rentbilly', 'ikwilhuren', 'telegram', 'application']);
const ROLES = new Set(['application', 'funda-browser', 'huurwoningen-browser', 'pararius-browser']);
const MONITORS = new Set(['funda', 'huurwoningen', 'woldring', 'vesteda', 'gruno', 'lamberink', 'vandermeulen', 'maxx', 'rentola', 'pararius', 'solide', 'gohome', 'rentbilly', 'ikwilhuren']);

// Prisma can load .env while constructing a client. Test isolation must not
// depend on the DSN being absent or on which module loaded configuration first.
function telemetryEnabled(env) {
  return Boolean(env.SENTRY_DSN) && env.NODE_ENV !== 'test' && !env.NODE_TEST_CONTEXT;
}

function sanitizeEvent(event) {
  const tags = {};
  if (SOURCES.has(event.tags?.source)) tags.source = event.tags.source;
  if (ROLES.has(event.tags?.component)) tags.component = event.tags.component;
  if (typeof event.tags?.category === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(event.tags.category)) tags.category = event.tags.category;
  const category = tags.category ?? 'UNHANDLED_ERROR';
  const values = (event.exception?.values ?? []).map(value => ({
    type: 'MonitorError', value: category,
    stacktrace: value.stacktrace ? { frames: (value.stacktrace.frames ?? []).map(frame => ({
      // No source lines, locals, request URLs, absolute user paths or error messages.
      filename: path.basename(String(frame.filename ?? '').replace(/\\/g, '/').split(/[?#]/)[0]),
      lineno: frame.lineno, colno: frame.colno, in_app: frame.in_app,
    })) } : undefined,
  }));
  return { event_id: event.event_id, timestamp: event.timestamp, platform: 'node',
    level: event.level ?? 'error', environment: event.environment, release: event.release,
    tags, fingerprint: ['housing-monitor', tags.component ?? 'application', tags.source ?? 'application', category],
    ...(values.length ? { exception: { values } } : { message: category }) };
}

function createTelemetry(sdk, env = process.env, component = 'application') {
  const enabled = telemetryEnabled(env);
  if (!ROLES.has(component)) throw Error('INVALID_TELEMETRY_COMPONENT');
  if (enabled) {
    let url;
    try { url = new URL(env.SENTRY_DSN); } catch { throw Error('INVALID_SENTRY_DSN'); }
    if (url.protocol !== 'https:' || !url.username || url.password || url.search || url.hash || !/^\/\d+$/.test(url.pathname)) throw Error('INVALID_SENTRY_DSN');
    sdk.init({ dsn: env.SENTRY_DSN, environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV ?? 'development',
      release: env.SENTRY_RELEASE ?? env.RAILWAY_GIT_COMMIT_SHA,
      defaultIntegrations: false, integrations: [sdk.onUncaughtExceptionIntegration(), sdk.onUnhandledRejectionIntegration()],
      sendDefaultPii: false, sendClientReports: false, enableLogs: false,
      maxBreadcrumbs: 0, beforeSend: sanitizeEvent,
      initialScope: { tags: { component } } });
  }
  const attempt = fn => { if (!enabled) return; try { return fn(); } catch { /* Telemetry never breaks monitoring. */ } };
  return {
    report(error, source = 'application', category = 'RUN_FAILED') {
      if (!SOURCES.has(source)) source = 'application';
      if (typeof category !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(category)) category = 'RUN_FAILED';
      return attempt(() => sdk.captureException(error instanceof Error ? error : new Error(category),
        { tags: { source, component, category } }));
    },
    start(source, intervalSeconds) {
      if (!MONITORS.has(source) || !Number.isFinite(intervalSeconds) || intervalSeconds < 60 || env.SENTRY_CRONS_ENABLED !== 'true' || component !== 'application') return;
      return attempt(() => sdk.captureCheckIn({ monitorSlug: 'housing-' + source, status: 'in_progress' }, {
        schedule: { type: 'interval', value: Math.max(1, Math.ceil(intervalSeconds / 60)), unit: 'minute' },
        checkinMargin: 5, maxRuntime: 7, failureIssueThreshold: 2, recoveryThreshold: 1,
      }));
    },
    finish(source, checkInId, status) {
      if (!checkInId || !MONITORS.has(source) || env.SENTRY_CRONS_ENABLED !== 'true' || component !== 'application' || !['ok', 'error'].includes(status)) return;
      return attempt(() => sdk.captureCheckIn({ monitorSlug: 'housing-' + source, checkInId, status }));
    },
    async flush() { if (!enabled) return false; try { return await sdk.flush(2000); } catch { return false; } },
  };
}
let instance;
function init(component = 'application') {
  if (instance) return instance;
  let sdk;
  try {
    if (telemetryEnabled(process.env)) {
      try { sdk = require('@sentry/node'); }
      catch { sdk = require('/tmp/funda-browser/node_modules/@sentry/node'); }
    }
    instance = createTelemetry(sdk, process.env, component);
  } catch {
    console.error('SENTRY_INIT_FAILED: error monitoring disabled; check configuration');
    instance = createTelemetry(undefined, {}, component);
  }
  return instance;
}
module.exports = { init, createTelemetry, sanitizeEvent };
