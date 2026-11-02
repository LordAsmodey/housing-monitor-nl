import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { assertStagingIsolation, isStagingEnvironment } from '../config/staging-isolation';

/** Runs only migrate deploy against the immutable staging target, without dotenv.
 * Copying the tracked schema/migrations to an empty cwd removes Prisma 6's
 * implicit project/schema-directory .env discovery paths. */
export function runStagingMigration(input: NodeJS.ProcessEnv = process.env): number {
  assertStagingIsolation(input);
  if (!isStagingEnvironment(input)) throw new Error('Staging migration requires explicit staging mode');
  const folder = mkdtempSync(resolve(tmpdir(), 'housing-staging-migrate-'));
  try {
    const projectRoot = resolve(__dirname, '../..');
    cpSync(resolve(projectRoot, 'prisma/schema.prisma'), resolve(folder, 'schema.prisma'));
    cpSync(resolve(projectRoot, 'prisma/migrations'), resolve(folder, 'migrations'), { recursive: true });
    const result = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', resolve(folder, 'schema.prisma')], {
      cwd: folder,
      env: { DATABASE_URL: input.DATABASE_URL, PATH: process.env.PATH, PRISMA_HIDE_UPDATE_MESSAGE: 'true' },
      encoding: 'utf8',
      // Do not forward Prisma output: unexpected errors can contain URLs/secrets.
      stdio: 'pipe',
    });
    if (result.error || result.signal || result.status !== 0) {
      console.error('Staging migration failed; dedicated database was not confirmed migrated');
      return 1;
    }
    console.log('Staging migrations applied to the dedicated database');
    return 0;
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

if (require.main === module) {
  try { process.exitCode = runStagingMigration(); }
  catch { console.error('Staging migration refused; verify isolation configuration'); process.exitCode = 1; }
}
