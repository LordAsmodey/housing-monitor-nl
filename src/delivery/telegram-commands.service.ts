import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AdminService } from '../admin/admin.service';
import { parseEnvironment } from '../config/environment';
import { botSchema, formatSourceList, isListCommand, TelegramPollingError, TelegramUpdatesClient, updatesSchema } from './telegram-commands';

@Injectable()
export class TelegramCommandsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramCommandsService.name);
  private readonly config = parseEnvironment(process.env);
  private readonly client = new TelegramUpdatesClient(this.config.TELEGRAM_BOT_TOKEN ?? '');
  private bot?: { id: number; username: string };
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private retryAt = 0;

  constructor(private readonly db: PrismaService, private readonly admin: AdminService) {}

  onModuleInit() {
    if (!this.config.TELEGRAM_DELIVERY_ENABLED || !this.config.TELEGRAM_COMMANDS_ENABLED) return;
    this.timer = setInterval(() => {
      if (this.active || Date.now() < this.retryAt) return;
      this.active = this.tick().catch((error: unknown) => {
        this.retryAt = Date.now() + (error instanceof TelegramPollingError ? error.retryAfter : 10) * 1000;
        this.logger.error('Telegram command polling failed; check API connectivity, webhook and other consumers');
      }).finally(() => { this.active = undefined; });
    }, 3000);
  }

  async onModuleDestroy() { clearInterval(this.timer); await this.active; }

  async tick() {
    if (!this.config.TELEGRAM_DELIVERY_ENABLED || !this.config.TELEGRAM_COMMANDS_ENABLED) return;
    const bot = this.bot ?? botSchema.parse(await this.client.call('getMe'));
    this.bot = bot;
    await this.db.$transaction(async tx => {
      // Non-blocking lock prevents simultaneous getUpdates during rolling deploys.
      const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(740012) AS acquired`;
      if (!lock?.acquired) return;
      const cursor = await tx.telegramUpdateCursor.upsert({ where: { id: String(bot.id) }, create: { id: String(bot.id) }, update: {} });
      const updates = updatesSchema.parse(await this.client.call('getUpdates', {
        offset: cursor.offset, timeout: 0, limit: 100, allowed_updates: ['message'],
      }));
      let offset = cursor.offset;
      let payloads: string[] | undefined;
      for (const update of updates) {
        if (update.update_id < cursor.offset) continue;
        offset = Math.max(offset, update.update_id + 1);
        if (!isListCommand(update, this.config.TELEGRAM_CHAT_ID, bot.username)) continue;
        payloads ??= formatSourceList(await this.admin.overview());
        for (const [part, payload] of payloads.entries()) {
          const idempotencyKey = `command:${bot.id}:${update.update_id}:${part}`;
          await tx.notificationOutbox.upsert({ where: { idempotencyKey }, update: {}, create: {
            idempotencyKey, destinationRef: this.config.TELEGRAM_CHAT_ID, payload,
          } });
        }
      }
      // Acknowledgement is only sent on the next poll, after this commit.
      await tx.telegramUpdateCursor.update({ where: { id: cursor.id }, data: { offset } });
    }, { timeout: 25_000 });
  }
}
