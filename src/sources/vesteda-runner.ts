import type { PrismaService } from '../database/prisma.service';
import type { ListingsService } from '../listings/listings.service';
import { SOURCE_ID, SEARCH_URL, FILTERS, collect } from './vesteda-core';

type Options = { destination: string; intervalSeconds?: number; collector?: typeof collect };
type Result = { skipped: true } | { skipped: false; runId: string; inspected: number; matched: number; created: number; baseline: boolean };
// Existing runner provides the PostgreSQL lease, cooldown and transactional outbox.
const runFunda: (db: PrismaService, listings: ListingsService, options: Options & { definition: typeof definition }) => Promise<Result> =
  require('../../scripts/funda-runner.cjs').runFunda;
const definition = { SOURCE_ID, SEARCH_URL, FILTERS, name: 'Vesteda — Groningen +20 km, €500–1500',
  baseUrl: 'https://www.vesteda.com', allowedDomains: ['www.vesteda.com'] };
export function runVesteda(db: PrismaService, listings: ListingsService, options: Options) {
  return runFunda(db, listings, { ...options, collector: options.collector ?? collect, definition });
}
