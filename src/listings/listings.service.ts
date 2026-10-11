import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { z } from 'zod';

const listingSchema = z.object({
  externalId: z.string().min(1).max(256),
  canonicalUrl: z.url().max(2048).refine(v => /^https?:/.test(v) && !new URL(v).username && !new URL(v).password),
  title: z.string().min(1).max(500), city: z.string().min(1).max(200),
  rentPrice: z.number().nonnegative().max(99999999).optional(),
  areaM2: z.number().positive().max(999999).optional(),
  rooms: z.number().positive().max(999).optional(),
});
export type ListingInput = z.infer<typeof listingSchema>;

@Injectable()
export class ListingsService {
  constructor(private readonly db: PrismaService) {}

  // Only call after a source run has passed validation. Failure is not an empty run.
  async recordValidatedRun(sourceId: string, input: ListingInput[], destinationRef: string) {
    if (!/^-[1-9]\d*$/.test(destinationRef)) throw new Error('Invalid Telegram destination');
    const listings = z.array(listingSchema).parse(input);
    return this.db.$transaction(async tx => {
      // Lock the source so parallel first runs cannot publish the baseline.
      const sources = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Source" WHERE id = ${sourceId} FOR UPDATE`;
      if (!sources.length) throw new Error('Unknown source');
      const source = await tx.source.findUniqueOrThrow({ where: { id: sourceId } });
      const now = new Date();
      let created = 0;
      for (const item of listings) {
        const url = new URL(item.canonicalUrl); url.hash = '';
        const canonicalUrl = url.href;
        if (canonicalUrl.length > 2048) throw new Error('Canonical URL exceeds supported length');
        const urlFingerprint = createHash('sha256').update(canonicalUrl).digest('hex');
        const existing = await tx.housingListing.findFirst({ where: { sourceId, OR: [{ externalId: item.externalId }, { urlFingerprint }] } });
        if (existing) {
          await tx.housingListing.update({ where: { id: existing.id }, data: { lastSeenAt: now } });
          continue;
        }
        const listing = await tx.housingListing.create({ data: { ...item, canonicalUrl, urlFingerprint, sourceId } });
        created++;
        if (source.baselineAt) {
          const payload = [item.title, item.city,
            item.rentPrice === undefined ? '' : `Аренда: €${item.rentPrice}`,
            item.areaM2 === undefined ? '' : `Площадь: ${item.areaM2} м²`,
            item.rooms === undefined ? '' : `Комнат: ${item.rooms}`,
            `Источник: ${source.name.slice(0, 200)}`, `Обнаружено: ${now.toISOString()}`, canonicalUrl].filter(Boolean).join('\n');
          await tx.notificationOutbox.create({ data: { listingId: listing.id, destinationRef,
            idempotencyKey: `new:${listing.id}:${destinationRef}`, payload } });
        }
      }
      await tx.source.update({ where: { id: sourceId }, data: { baselineAt: source.baselineAt ?? now, lastAttemptAt: now, lastSuccessAt: now } });
      return { created, baseline: !source.baselineAt };
    }, { timeout: 30000 });
  }
}
