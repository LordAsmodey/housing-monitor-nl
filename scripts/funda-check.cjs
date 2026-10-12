'use strict';
const { collect, FundaError } = require('./funda-core.cjs');
const { runFunda } = require('./funda-runner.cjs');
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--dry-run', '--once'].includes(args[0])) {
    throw new FundaError('USAGE: funda:check -- --dry-run|--once');
  }
  if (args[0] === '--dry-run') {
    const result = await collect();
    console.log(JSON.stringify({ inspected: result.inspected, matched: result.listings.length, pages: result.pages }));
    return;
  }
  require('reflect-metadata');
  const { parseEnvironment } = require('../dist/config/environment.js');
  const config = parseEnvironment(process.env);
  if (!config.FUNDA_MONITOR_ENABLED) throw new FundaError('MONITOR_DISABLED');
  const { PrismaService } = require('../dist/database/prisma.service.js');
  const { ListingsService } = require('../dist/listings/listings.service.js');
  const db = new PrismaService();
  try {
    await db.$connect();
    console.log(JSON.stringify(await runFunda(db, new ListingsService(db), {
      destination: config.TELEGRAM_CHAT_ID, intervalSeconds: config.MONITOR_INTERVAL_SECONDS,
    })));
  } finally { await db.$disconnect(); }
}
main().catch(error => {
  console.error(error instanceof FundaError ? error.category : 'FUNDA_CHECK_FAILED');
  process.exitCode = 1;
});
