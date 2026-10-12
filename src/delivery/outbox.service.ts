import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { parseEnvironment } from '../config/environment';
import { DeliveryError, TelegramSender } from './telegram';

@Injectable()
export class OutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxService.name);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private readonly config = parseEnvironment(process.env);
  private readonly sender = new TelegramSender(this.config.TELEGRAM_BOT_TOKEN ?? '');
  constructor(private readonly db: PrismaService) {}
  onModuleInit() {
    if (!this.config.TELEGRAM_DELIVERY_ENABLED) return;
    this.timer = setInterval(() => {
      if (!this.active) this.active = this.tick().catch((error: unknown) => {
        require('../../scripts/telemetry.cjs').init().report(error, 'telegram', 'OUTBOX_TICK_FAILED');
        // Never log Prisma/transport errors: they can include credentials or payloads.
        this.logger.error('Outbox tick failed; pending delivery state retained');
      }).finally(() => { this.active = undefined; });
    }, 1000);
  }
  async onModuleDestroy() { clearInterval(this.timer); await this.active; }

  async tick() {
    if (!this.config.TELEGRAM_DELIVERY_ENABLED) return;
    const token = randomUUID();
    const job = await this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(740011)`;
      const now = new Date();
      await tx.notificationOutbox.updateMany({ where: { status: 'SENDING', lockedUntil: { lte: now } },
        data: { status: 'UNCERTAIN', lastErrorCategory: 'WORKER_INTERRUPTED', lockToken: null, lockedUntil: null } });
      const gate = await tx.deliveryGate.upsert({ where: { id: 'telegram' }, create: { id: 'telegram', nextAttemptAt: now }, update: {} });
      if (gate.nextAttemptAt > now) return null;
      const next = await tx.notificationOutbox.findFirst({ where: { status: 'PENDING', nextAttemptAt: { lte: now },
        destinationRef: this.config.TELEGRAM_CHAT_ID }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      if (!next) return null;
      const until = new Date(now.getTime() + 60000);
      await tx.deliveryGate.update({ where: { id: 'telegram' }, data: { nextAttemptAt: until } });
      return tx.notificationOutbox.update({ where: { id: next.id }, data: { status: 'SENDING', lockToken: token, lockedUntil: until, attempts: { increment: 1 } } });
    });
    if (!job) return;
    let messageId: string | undefined;
    let failure: DeliveryError | undefined;
    try { messageId = await this.sender.send(job.destinationRef, job.payload); }
    catch (e) { failure = e instanceof DeliveryError ? e : new DeliveryError('UNKNOWN_UNCERTAIN', true); }
    const now = new Date();
    const retry = failure?.retryable && job.attempts < this.config.TELEGRAM_MAX_ATTEMPTS;
    const delay = Math.max(3100, (failure?.retryAfter ?? 0) * 1000,
      retry ? Math.min(3600000, 1000 * 2 ** job.attempts) + Math.floor(Math.random() * 1000) : 0);
    const persisted = await this.db.$transaction(async tx => {
      const updated = await tx.notificationOutbox.updateMany({ where: { id: job.id, status: 'SENDING', lockToken: token }, data: {
        status: failure ? failure.uncertain ? 'UNCERTAIN' : retry ? 'PENDING' : 'DEAD_LETTER' : 'SENT',
        telegramMessageId: messageId, sentAt: messageId ? now : null,
        lastErrorCategory: failure?.category ?? null, nextAttemptAt: new Date(now.getTime() + delay), lockedUntil: null, lockToken: null,
      } });
      if (updated.count) await tx.deliveryGate.update({ where: { id: 'telegram' }, data: { nextAttemptAt: new Date(now.getTime() + delay) } });
      return updated.count;
    });
    if (persisted && failure && (failure.uncertain || !retry)) {
      require('../../scripts/telemetry.cjs').init().report(failure, 'telegram', failure.uncertain ? 'DELIVERY_UNCERTAIN' : 'DELIVERY_DEAD_LETTER');
    }
  }
}
