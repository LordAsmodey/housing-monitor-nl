import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ListingsService } from '../listings/listings.service';
import { parseEnvironment } from '../config/environment';

const { runFunda } = require('../../scripts/funda-runner.cjs') as {
  runFunda(db: PrismaService, listings: ListingsService, options: { destination: string; intervalSeconds: number }): Promise<unknown>;
};

@Injectable()
export class FundaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FundaService.name);
  private readonly config = parseEnvironment(process.env);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  constructor(private readonly db: PrismaService, private readonly listings: ListingsService) {}
  onModuleInit() {
    if (!this.config.FUNDA_MONITOR_ENABLED) return;
    // Readiness/Prisma initialization finishes before the first scheduled tick.
    this.timer = setInterval(() => this.schedule(), 5000);
  }
  private schedule() {
    if (this.active) return;
    this.active = this.tick().catch(() => {
      // Error categories are persisted on MonitoringRun. No HTML, tokens or URLs in logs.
      this.logger.warn('Funda check failed; inspect MonitoringRun errorCategory');
    }).finally(() => { this.active = undefined; });
  }
  async tick() {
    if (!this.config.FUNDA_MONITOR_ENABLED) return;
    return runFunda(this.db, this.listings, { destination: this.config.TELEGRAM_CHAT_ID!,
      intervalSeconds: this.config.MONITOR_INTERVAL_SECONDS });
  }
  async onModuleDestroy() { clearInterval(this.timer); await this.active; }
}
