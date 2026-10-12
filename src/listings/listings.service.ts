import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { z } from 'zod';
import { Prisma } from '@prisma/client';

const listingSchema = z.object({
  externalId: z.string().min(1).max(256),
  canonicalUrl: z.url().max(2048).refine(v => /^https?:/.test(v) && !new URL(v).username && !new URL(v).password),
  title: z.string().min(1).max(500), city: z.string().min(1).max(200),
  rentPrice: z.number().nonnegative().max(99999999).optional(),
  serviceCosts: z.number().nonnegative().max(99999999).optional(),
  address: z.string().min(1).max(500).optional(),
  areaM2: z.number().positive().max(999999).optional(),
  rooms: z.number().positive().max(999).optional(),
  publishedAt: z.date().optional(),
  availabilityStatus: z.enum(['available', 'unavailable', 'unknown']).optional(),
  housingDetails: z.object({
    propertyType: z.enum(['apartment', 'studio']),
    availableFrom: z.string().regex(/^(now|\d{4}-\d{2}-\d{2})$/).optional(),
    energyLabel: z.string().regex(/^(A\+{0,4}|[B-G])$/).optional(),
    huurtoeslag: z.boolean().optional(),
    utilities: z.enum(['included', 'separate', 'serviceCosts']).optional(),
    applicationsClosed: z.boolean(),
  }).optional(),
});
export type ListingInput = z.infer<typeof listingSchema>;

@Injectable()
export class ListingsService {
  constructor(private readonly db: PrismaService) {}

  // Only call after a source run has passed validation. Failure is not an empty run.
  async recordValidatedRun(sourceId: string, input: ListingInput[], destinationRef: string) {
    return this.db.$transaction(tx => this.recordValidatedRunInTransaction(tx, sourceId, input, destinationRef), { timeout: 30000 });
  }

  async recordValidatedRunInTransaction(tx: Prisma.TransactionClient, sourceId: string, input: ListingInput[], destinationRef: string) {
    if (!/^-[1-9]\d*$/.test(destinationRef)) throw new Error('Invalid Telegram destination');
    const listings = z.array(listingSchema).parse(input);
    // Lock the source so parallel first runs cannot publish the baseline.
    const sources = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Source" WHERE id = ${sourceId} FOR UPDATE`;
    if (!sources.length) throw new Error('Unknown source');
    const source = await tx.source.findUniqueOrThrow({ where: { id: sourceId } });
    const now = new Date();
    let created = 0;
    for (const item of listings) {
      const { housingDetails, ...storedItem } = item;
      const url = new URL(item.canonicalUrl); url.hash = '';
      const canonicalUrl = url.href;
      if (canonicalUrl.length > 2048) throw new Error('Canonical URL exceeds supported length');
      const urlFingerprint = createHash('sha256').update(canonicalUrl).digest('hex');
      const existing = await tx.housingListing.findFirst({ where: { sourceId, OR: [{ externalId: item.externalId }, { urlFingerprint }] } });
      const transitioned = existing?.availabilityStatus === 'unavailable' && item.availabilityStatus === 'available';
      let listing;
      if (existing) {
        listing = await tx.housingListing.update({ where: { id: existing.id }, data: {
          lastSeenAt: now,
          ...storedItem, canonicalUrl,
          ...(housingDetails ? { rawSourceRef: JSON.stringify(housingDetails) } : {}),
        } });
        if (!transitioned) continue;
      } else {
        listing = await tx.housingListing.create({ data: { ...storedItem, canonicalUrl, urlFingerprint, sourceId,
          ...(housingDetails ? { rawSourceRef: JSON.stringify(housingDetails) } : {}) } });
        created++;
      }
      if (source.baselineAt && item.availabilityStatus !== 'unavailable') {
        const payload = [item.title, item.city,
          housingDetails ? `Тип: ${housingDetails.propertyType === 'apartment' ? 'квартира' : 'студия'}` : '',
          housingDetails?.availableFrom ? `Доступность: ${housingDetails.availableFrom === 'now' ? 'сейчас' : housingDetails.availableFrom}` : '',
          item.rentPrice === undefined ? '' : `Аренда: €${item.rentPrice}`,
          housingDetails ? `Servicekosten: ${item.serviceCosts === undefined ? 'не указаны' : '€' + item.serviceCosts}` : '',
          housingDetails && item.rentPrice !== undefined && item.serviceCosts !== undefined
            ? `Аренда + servicekosten: €${((Math.round(item.rentPrice * 100) + Math.round(item.serviceCosts * 100)) / 100).toFixed(2)}` : '',
          item.areaM2 === undefined ? '' : `Площадь: ${item.areaM2} м²`,
          housingDetails ? `Энергокласс: ${housingDetails.energyLabel ?? 'не указан'}` : '',
          housingDetails ? `Huurtoeslag: ${housingDetails.huurtoeslag === undefined ? 'не указано' : housingDetails.huurtoeslag ? 'да' : 'нет'}` : '',
          housingDetails ? `Коммунальные услуги: ${housingDetails.utilities ? {included:'включены',separate:'оплачиваются отдельно',serviceCosts:'через servicekosten'}[housingDetails.utilities] : 'порядок оплаты не указан'}` : '',
          housingDetails?.applicationsClosed ? 'Приём заявок закрыт (Inschrijving gesloten)' : '',
          item.rooms === undefined ? '' : `Комнат: ${item.rooms}`,
          item.publishedAt === undefined ? '' : `Опубликовано: ${item.publishedAt.toISOString()}`,
          `Источник: ${source.name.slice(0, 200)}`, `Обнаружено: ${now.toISOString()}`, canonicalUrl].filter(Boolean).join('\n');
        await tx.notificationOutbox.createMany({ skipDuplicates: true, data: [{ listingId: listing.id, destinationRef,
          idempotencyKey: `new:${listing.id}:${destinationRef}`, payload }] });
      }
    }
    await tx.source.update({ where: { id: sourceId }, data: { baselineAt: source.baselineAt ?? now, lastAttemptAt: now, lastSuccessAt: now } });
    return { created, baseline: !source.baselineAt };
  }
}
