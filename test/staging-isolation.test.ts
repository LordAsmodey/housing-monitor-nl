import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { assertStagingIsolation, isStagingEnvironment, STAGING_TARGET } from '../src/config/staging-isolation';
import { parseBootstrapEnvironment } from '../src/config/environment';
import { runStagingMigration } from '../src/database/staging-migrate';

const valid = (): NodeJS.ProcessEnv => ({
  DEPLOYMENT_MODE: 'staging',
  RAILWAY_PROJECT_ID: STAGING_TARGET.projectId,
  RAILWAY_ENVIRONMENT_ID: STAGING_TARGET.environmentId,
  RAILWAY_SERVICE_ID: STAGING_TARGET.serviceId,
  DATABASE_URL: `postgresql://${STAGING_TARGET.databaseUser}:test-password@${STAGING_TARGET.databaseHost}:5432/${STAGING_TARGET.databaseName}?schema=public`,
  COLLECTION_ENABLED: 'false',
  TELEGRAM_DELIVERY_ENABLED: 'false',
  TELEGRAM_COMMANDS_ENABLED: 'false',
});

test('passive staging starts without legacy chat/Redis credentials and validates port', () => {
  assert.doesNotThrow(() => assertStagingIsolation(valid()));
  assert.deepEqual(parseBootstrapEnvironment(valid()), { PORT: 3000 });
  assert.deepEqual(parseBootstrapEnvironment({ ...valid(), PORT: '3100' }), { PORT: 3100 });
  for (const PORT of ['0', '65536', 'abc']) {
    assert.throws(() => parseBootstrapEnvironment({ ...valid(), PORT }), /PORT/);
  }
});

test('immutable project, environment and service identities cannot be missing or overridden', () => {
  for (const key of ['RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_ID']) {
    for (const value of [undefined, 'production-resource-id']) {
      assert.throws(() => assertStagingIsolation({ ...valid(), [key]: value, [`EXPECTED_${key}`]: value }), new RegExp(key));
    }
  }
});

test('known staging project/environment cannot opt out of isolation by removing or changing mode', () => {
  for (const DEPLOYMENT_MODE of [undefined, 'legacy', 'production', 'STAGING']) {
    assert.throws(() => assertStagingIsolation({ ...valid(), DEPLOYMENT_MODE }), /DEPLOYMENT_MODE/);
  }
  assert.equal(isStagingEnvironment({ RAILWAY_ENVIRONMENT_NAME: 'staging' }), true);
  assert.throws(() => assertStagingIsolation({ RAILWAY_ENVIRONMENT_NAME: 'staging' }), /DEPLOYMENT_MODE/);
  assert.doesNotThrow(() => assertStagingIsolation({ DEPLOYMENT_MODE: 'legacy', DATABASE_URL: 'legacy-config' }));
});

test('every external-action flag must explicitly be false', () => {
  for (const key of ['COLLECTION_ENABLED', 'TELEGRAM_DELIVERY_ENABLED', 'TELEGRAM_COMMANDS_ENABLED']) {
    for (const value of [undefined, 'true', '0', false]) {
      assert.throws(() => assertStagingIsolation({ ...valid(), [key]: value }), new RegExp(key));
    }
  }
});

test('passive staging rejects bot, OAuth, telemetry, Redis and browser credentials', () => {
  for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_CLIENT_ID', 'SENTRY_DSN', 'REDIS_URL',
    'FUNDA_BROWSER_ORIGIN', 'FUNDA_BROWSER_TOKEN', 'HUURWONINGEN_BROWSER_ORIGIN', 'PARARIUS_BROWSER_TOKEN']) {
    assert.throws(() => assertStagingIsolation({ ...valid(), [key]: 'do-not-log-this-secret' }), (error: Error) => {
      assert.match(error.message, new RegExp(key));
      assert.doesNotMatch(error.message, /do-not-log-this-secret/);
      return true;
    });
  }
});

test('database identity and connection overrides fail closed without exposing credentials', () => {
  const original = new URL(valid().DATABASE_URL!);
  const variants: string[] = ['not-a-url', original.toString().replace('postgresql:', 'https:')];
  for (const [key, value] of [
    ['hostname', 'production.railway.internal'], ['port', '5433'],
    ['pathname', '/production'], ['username', 'postgres'], ['password', ''], ['hash', '#unexpected'],
    ['search', '?host=production.railway.internal'], ['search', '?schema=other'],
    ['search', '?schema=public&schema=public'], ['search', '?sslmode=disable'],
    ['pathname', '/%ZZ'], ['username', '%ZZ'],
  ] as const) {
    const url = new URL(original);
    url[key] = value;
    variants.push(url.toString());
  }
  for (const DATABASE_URL of variants) {
    assert.throws(() => assertStagingIsolation({ ...valid(), DATABASE_URL }), (error: Error) => {
      assert.match(error.message, /DATABASE_URL/);
      assert.doesNotMatch(error.message, /test-password|production\.railway/);
      return true;
    });
  }
  const withoutPort = new URL(original);
  withoutPort.port = '';
  withoutPort.search = '';
  assert.doesNotThrow(() => assertStagingIsolation({ ...valid(), DATABASE_URL: withoutPort.toString() }));
});

test('migration refuses invalid/legacy targets before filesystem or child execution', () => {
  const mkdir = mock.method(fs, 'mkdtempSync', () => { throw new Error('filesystem must not be reached'); });
  const spawn = mock.method(childProcess, 'spawnSync', () => { throw new Error('child must not be reached'); });
  try {
    assert.throws(() => runStagingMigration({ ...valid(), RAILWAY_PROJECT_ID: 'production' }), /RAILWAY_PROJECT_ID/);
    assert.throws(() => runStagingMigration({}), /explicit staging mode/);
    assert.equal(mkdir.mock.callCount(), 0);
    assert.equal(spawn.mock.callCount(), 0);
  } finally { mkdir.mock.restore(); spawn.mock.restore(); }
});

test('migration child receives isolated schema cwd and only explicit environment; temporary files are removed', () => {
  let isolatedFolder: string | undefined;
  const spawn = mock.method(childProcess, 'spawnSync', (executable, args, options) => {
    assert.equal(executable, process.execPath);
    assert.deepEqual(args.slice(1, 4), ['migrate', 'deploy', '--schema']);
    isolatedFolder = options.cwd;
    assert.equal(args[4], join(isolatedFolder!, 'schema.prisma'));
    assert.equal(fs.existsSync(join(isolatedFolder!, '.env')), false);
    assert.equal(fs.existsSync(join(isolatedFolder!, 'migrations/migration_lock.toml')), true);
    assert.deepEqual(Object.keys(options.env).sort(), ['DATABASE_URL', 'PATH', 'PRISMA_HIDE_UPDATE_MESSAGE']);
    assert.equal(options.env.DATABASE_URL, valid().DATABASE_URL);
    assert.equal(options.stdio, 'pipe');
    return { status: 0, signal: null, error: undefined };
  });
  try {
    assert.equal(runStagingMigration(valid()), 0);
    assert.equal(spawn.mock.callCount(), 1);
    assert.ok(isolatedFolder);
    assert.equal(fs.existsSync(isolatedFolder), false);
  } finally { spawn.mock.restore(); }
});

test('migration child failures remain nonzero, redact raw output and clean isolated files', () => {
  let isolatedFolder: string | undefined;
  const messages: string[] = [];
  const error = mock.method(console, 'error', (message: string) => { messages.push(message); });
  const spawn = mock.method(childProcess, 'spawnSync', (_executable, _args, options) => {
    isolatedFolder = options.cwd;
    return { status: 1, signal: null, stderr: 'postgresql://private-password@production', stdout: 'sensitive-sql' };
  });
  try {
    assert.equal(runStagingMigration(valid()), 1);
    assert.deepEqual(messages, ['Staging migration failed; dedicated database was not confirmed migrated']);
    assert.ok(isolatedFolder);
    assert.equal(fs.existsSync(isolatedFolder), false);
  } finally { spawn.mock.restore(); error.mock.restore(); }
});

test('real bootstrap process rejects wrong target before initializing application or telemetry', () => {
  const result = childProcess.spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: join(__dirname, '..'),
    env: { ...valid(), RAILWAY_PROJECT_ID: 'wrong-project', SENTRY_DSN: 'https://private-secret@must-not-contact.invalid/1' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Application startup refused/);
  assert.doesNotMatch(result.stderr, /private-secret|must-not-contact|Nest application|PrismaClient/);
});
