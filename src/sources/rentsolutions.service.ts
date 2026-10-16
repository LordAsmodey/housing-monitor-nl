import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ListingsService } from '../listings/listings.service';
import { parseEnvironment } from '../config/environment';
import { runRentsolutions } from './rentsolutions-runner';
import { SourceError } from './rentsolutions-core';

@Injectable()
export class RentsolutionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RentsolutionsService.name);
  private readonly config = parseEnvironment(process.env);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  constructor(private readonly db: PrismaService, private readonly listings: ListingsService) {}
  onModuleInit() {
    if (!this.config.RENTSOLUTIONS_MONITORING_ENABLED) {
      this.logger.log('Rentsolutions monitoring disabled by configuration');
      return;
    }
    this.logger.log(`Rentsolutions automatic monitoring scheduled: intervalSeconds=${this.config.MONITOR_INTERVAL_SECONDS}`);
    this.timer = setInterval(() => this.schedule(), 5000);
  }
  private schedule() {
    if (this.active) return;
    this.active = this.tick().then(result => {
      if (!result.skipped) this.logger.log(`Rentsolutions check succeeded: ${JSON.stringify(result)}`);
    }).catch((error: unknown) => {
      const category = error instanceof SourceError ? error.category : 'RUN_FAILED';
      require('../../scripts/telemetry.cjs').init().report(error, 'rentsolutions', category);
      this.logger.warn(`Rentsolutions check failed: category=${category}`);
    }).finally(() => { this.active = undefined; });
  }
  tick() {
    if (!this.config.RENTSOLUTIONS_MONITORING_ENABLED) return Promise.resolve({ skipped: true as const });
    return runRentsolutions(this.db, this.listings, { destination: this.config.TELEGRAM_CHAT_ID,
      intervalSeconds: this.config.MONITOR_INTERVAL_SECONDS });
  }
  async onModuleDestroy() { clearInterval(this.timer); await this.active; }
}
