import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ListingsService } from '../listings/listings.service';
import { parseEnvironment } from '../config/environment';

const { runFunda } = require('../../scripts/funda-runner.cjs') as {
  runFunda(db: PrismaService, listings: ListingsService, options: { destination: string; intervalSeconds: number }):
    Promise<{ skipped: true } | { skipped: false; runId: string; inspected: number; matched: number; created: number; baseline: boolean }>;
};
const { FundaError } = require('../../scripts/funda-core.cjs') as {
  FundaError: new(category: string) => Error & { category: string };
};

@Injectable()
export class FundaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FundaService.name);
  private readonly config = parseEnvironment(process.env);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  constructor(private readonly db: PrismaService, private readonly listings: ListingsService) {}
  onModuleInit() {
    // Readiness/Prisma initialization finishes before the first scheduled tick.
    this.logger.log(`Funda automatic monitoring scheduled: intervalSeconds=${this.config.MONITOR_INTERVAL_SECONDS}`);
    this.timer = setInterval(() => this.schedule(), 5000);
  }
  private schedule() {
    if (this.active) return;
    this.active = this.tick().then(result => {
      if (!result.skipped) this.logger.log(`Funda check succeeded: ${JSON.stringify(result)}`);
    }).catch((error: unknown) => {
      // Only controlled categories and counts; never raw transport/Prisma errors or HTML.
      const category = error instanceof FundaError ? error.category : 'RUN_FAILED';
      this.logger.warn(`Funda check failed: category=${category}`);
    }).finally(() => { this.active = undefined; });
  }
  async tick() {
    return runFunda(this.db, this.listings, { destination: this.config.TELEGRAM_CHAT_ID,
      intervalSeconds: this.config.MONITOR_INTERVAL_SECONDS });
  }
  async onModuleDestroy() { clearInterval(this.timer); await this.active; }
}
