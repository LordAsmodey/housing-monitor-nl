import type { PrismaService } from '../database/prisma.service';
import type { ListingsService } from '../listings/listings.service';
import { SOURCE_ID, SEARCH_URL, FILTERS, RUN_TIMEOUT_MS, collect, readCollectionState, type CollectOptions } from './rentola-core';
import type { Prisma } from '@prisma/client';

type CollectionResult = Pick<Awaited<ReturnType<typeof collect>>, 'listings' | 'inspected'> & Partial<Awaited<ReturnType<typeof collect>>>;
type Options = { destination: string; intervalSeconds?: number; collector?: (options:CollectOptions) => Promise<CollectionResult> };
type Result = { skipped: true } | { skipped: false; runId: string; inspected: number; matched: number; created: number; baseline: boolean };
// Existing runner provides the PostgreSQL lease, cooldown and transactional outbox.
const runFunda: (db: PrismaService, listings: ListingsService, options: Options & { definition: typeof definition;
  persistCollection: (tx:Prisma.TransactionClient, result:CollectionResult) => Promise<void> }) => Promise<Result> =
  require('../../scripts/funda-runner.cjs').runFunda;
const definition = { SOURCE_ID, SEARCH_URL, FILTERS, requireAvailable: true, name: 'Rentola — Groningen',
  baseUrl: 'https://rentola.nl', allowedDomains: ['rentola.nl'], runTimeoutMs: RUN_TIMEOUT_MS };
export function runRentola(db: PrismaService, listings: ListingsService, options: Options) {
  const collector = options.collector ?? collect;
  return runFunda(db, listings, { ...options, definition, collector: async context => {
    const [stored, source, search] = await Promise.all([
      db.sourceCollectionState.findUnique({where:{sourceId:SOURCE_ID}}),
      db.source.findUniqueOrThrow({where:{id:SOURCE_ID}}),
      db.searchConfiguration.findUnique({where:{sourceId:SOURCE_ID}}),
    ]);
    return collector({...context,previousState:readCollectionState(stored?.state),
      forceFull:!source.baselineAt || search?.revision !== search?.appliedRevision});
  }, persistCollection: async (tx, result) => {
    if (result.collectionState) await tx.sourceCollectionState.upsert({where:{sourceId:SOURCE_ID},
      create:{sourceId:SOURCE_ID,state:result.collectionState},update:{state:result.collectionState}});
  } });
}
