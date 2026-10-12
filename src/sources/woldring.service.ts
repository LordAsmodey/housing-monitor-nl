import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ListingsService } from '../listings/listings.service';
import { parseEnvironment } from '../config/environment';
const { runWoldring } = require('../../scripts/woldring-runner.cjs');
const { FundaError } = require('../../scripts/woldring-core.cjs');

@Injectable()
export class WoldringService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WoldringService.name);
  private readonly config = parseEnvironment(process.env);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  constructor(private readonly db: PrismaService, private readonly listings: ListingsService) {}
  onModuleInit() {
    this.logger.log(`Woldring automatic monitoring scheduled: intervalSeconds=${this.config.MONITOR_INTERVAL_SECONDS}`);
    this.timer = setInterval(() => this.schedule(), 5000);
  }
  private schedule() {
    if (this.active) return;
    this.active = this.tick().then((result: { skipped: boolean }) => {
      if (!result.skipped) this.logger.log(`Woldring check succeeded: ${JSON.stringify(result)}`);
    }).catch((error: unknown) => {
      const category = error instanceof FundaError ? (error as Error & { category: string }).category : 'RUN_FAILED';
      this.logger.warn(`Woldring check failed: category=${category}`);
    }).finally(() => { this.active = undefined; });
  }
  async tick() {
    return runWoldring(this.db, this.listings, {destination: this.config.TELEGRAM_CHAT_ID,
      intervalSeconds: this.config.MONITOR_INTERVAL_SECONDS});
  }
  async onModuleDestroy() { clearInterval(this.timer); await this.active; }
}
