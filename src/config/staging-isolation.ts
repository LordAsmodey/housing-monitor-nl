/** Non-secret identity of the fresh B03 infrastructure. Never derive this allowlist
 * from runtime EXPECTED_* variables: a mistaken production configuration must fail. */
export const STAGING_TARGET = Object.freeze({
  projectId: 'b84d6133-2fc7-4087-92ad-4e6c96b77f7a',
  environmentId: '666d7b8d-3b4b-4f58-abfe-b6fb27b4964c',
  serviceId: '74c2f21f-cb7f-40bd-b6ab-e29233472f60',
  databaseHost: 'postgres.railway.internal',
  databasePort: '5432',
  databaseName: 'housing_v2_staging',
  databaseUser: 'housing_v2_staging',
});

type Environment = Record<string, unknown>;

export function isStagingEnvironment(input: Environment): boolean {
  return input.DEPLOYMENT_MODE === 'staging' ||
    input.RAILWAY_PROJECT_ID === STAGING_TARGET.projectId ||
    input.RAILWAY_ENVIRONMENT_ID === STAGING_TARGET.environmentId ||
    input.RAILWAY_ENVIRONMENT_NAME === 'staging';
}

/** Must run before importing application modules, connecting to DB or spawning CLI. */
export function assertStagingIsolation(input: Environment): void {
  const reject = (key: string): never => { throw new Error(`Staging isolation rejected: ${key}`); };
  if (input.DEPLOYMENT_MODE !== undefined && input.DEPLOYMENT_MODE !== 'legacy' && input.DEPLOYMENT_MODE !== 'staging') reject('DEPLOYMENT_MODE');
  if (!isStagingEnvironment(input)) return;
  if (input.DEPLOYMENT_MODE !== 'staging') reject('DEPLOYMENT_MODE');
  for (const [key, expected] of [
    ['RAILWAY_PROJECT_ID', STAGING_TARGET.projectId],
    ['RAILWAY_ENVIRONMENT_ID', STAGING_TARGET.environmentId],
    ['RAILWAY_SERVICE_ID', STAGING_TARGET.serviceId],
  ] as const) if (input[key] !== expected) reject(key);
  for (const key of ['COLLECTION_ENABLED', 'TELEGRAM_DELIVERY_ENABLED', 'TELEGRAM_COMMANDS_ENABLED']) {
    if (input[key] !== 'false') reject(key);
  }
  // B03 is a passive server, not a collector or an auth/bot integration.
  for (const key of Object.keys(input)) {
    if ((/_BROWSER_(ORIGIN|TOKEN)$/.test(key) || /^(TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|SENTRY_DSN|GOOGLE_CLIENT_SECRET|GOOGLE_CLIENT_ID|GOOGLE_OAUTH_CLIENT_SECRET|GOOGLE_OAUTH_CLIENT_ID|REDIS_URL)$/.test(key)) && input[key]) reject(key);
  }
  let database: URL;
  try { database = new URL(String(input.DATABASE_URL ?? '')); }
  catch { return reject('DATABASE_URL'); }
  try {
    if (!['postgres:', 'postgresql:'].includes(database.protocol) ||
      database.hostname !== STAGING_TARGET.databaseHost ||
      (database.port || '5432') !== STAGING_TARGET.databasePort ||
      decodeURIComponent(database.pathname) !== `/${STAGING_TARGET.databaseName}` ||
      decodeURIComponent(database.username) !== STAGING_TARGET.databaseUser ||
      !database.password || database.hash ||
      [...database.searchParams].some(([key, value]) => key !== 'schema' || value !== 'public') ||
      database.searchParams.getAll('schema').length > 1) reject('DATABASE_URL');
  } catch { reject('DATABASE_URL'); }
}
