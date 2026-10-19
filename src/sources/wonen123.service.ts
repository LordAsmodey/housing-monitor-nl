import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ListingsService } from '../listings/listings.service';
import { parseEnvironment } from '../config/environment';
import { runWonen123 } from './wonen123-runner';
import { SourceError } from './wonen123-core';

@Injectable()
export class Wonen123Service implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(Wonen123Service.name);
  private readonly config = parseEnvironment(process.env);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  constructor(private readonly db: PrismaService, private readonly listings: ListingsService) {}
  onModuleInit() {
    if (!this.config.WONEN123_MONITORING_ENABLED) {
      this.logger.log('Wonen123 monitoring disabled by configuration');
      return;
    }
    this.logger.log(`Wonen123 automatic monitoring scheduled: intervalSeconds=${this.config.MONITOR_INTERVAL_SECONDS}`);
    this.timer = setInterval(() => this.schedule(), 5000);
  }
  private schedule() {
    if (this.active) return;
    this.active = this.tick().then(result => {
      if (!result.skipped) this.logger.log(`Wonen123 check succeeded: ${JSON.stringify(result)}`);
    }).catch((error: unknown) => {
      const category = error instanceof SourceError ? error.category : 'RUN_FAILED';
      require('../../scripts/telemetry.cjs').init().report(error, 'wonen123', category);
      this.logger.warn(`Wonen123 check failed: category=${category}`);
    }).finally(() => { this.active = undefined; });
  }
  tick() {
    if (!this.config.WONEN123_MONITORING_ENABLED) return Promise.resolve({ skipped: true as const });
    return runWonen123(this.db, this.listings, { destination: this.config.TELEGRAM_CHAT_ID,
      intervalSeconds: this.config.MONITOR_INTERVAL_SECONDS });
  }
  async onModuleDestroy() { clearInterval(this.timer); await this.active; }
}
