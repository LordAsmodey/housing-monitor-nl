import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ListingsService } from '../listings/listings.service';
import { parseEnvironment } from '../config/environment';
import { runLamberink } from './lamberink-runner';
import { SourceError } from './lamberink-core';

@Injectable()
export class LamberinkService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LamberinkService.name);
  private readonly config = parseEnvironment(process.env);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  constructor(private readonly db: PrismaService, private readonly listings: ListingsService) {}
  onModuleInit() {
    if (!this.config.LAMBERINK_MONITORING_ENABLED) {
      this.logger.log('Lamberink monitoring disabled by configuration');
      return;
    }
    this.logger.log(`Lamberink automatic monitoring scheduled: intervalSeconds=${this.config.MONITOR_INTERVAL_SECONDS}`);
    this.timer = setInterval(() => this.schedule(), 5000);
  }
  private schedule() {
    if (this.active) return;
    this.active = this.tick().then(result => {
      if (!result.skipped) this.logger.log(`Lamberink check succeeded: ${JSON.stringify(result)}`);
    }).catch((error: unknown) => {
      const category = error instanceof SourceError ? error.category : 'RUN_FAILED';
      require('../../scripts/telemetry.cjs').init().report(error, 'lamberink', category);
      this.logger.warn(`Lamberink check failed: category=${category}`);
    }).finally(() => { this.active = undefined; });
  }
  tick() {
    if (!this.config.LAMBERINK_MONITORING_ENABLED) return Promise.resolve({ skipped: true as const });
    return runLamberink(this.db, this.listings, { destination: this.config.TELEGRAM_CHAT_ID,
      intervalSeconds: this.config.MONITOR_INTERVAL_SECONDS });
  }
  async onModuleDestroy() { clearInterval(this.timer); await this.active; }
}
