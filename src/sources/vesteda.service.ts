import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ListingsService } from '../listings/listings.service';
import { parseEnvironment } from '../config/environment';
import { runVesteda } from './vesteda-runner';
import { SourceError } from './vesteda-core';

@Injectable()
export class VestedaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VestedaService.name);
  private readonly config = parseEnvironment(process.env);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  constructor(private readonly db: PrismaService, private readonly listings: ListingsService) {}
  onModuleInit() {
    if (!this.config.VESTEDA_MONITORING_ENABLED) {
      this.logger.log('Vesteda monitoring disabled by configuration');
      return;
    }
    this.logger.log(`Vesteda automatic monitoring scheduled: intervalSeconds=${this.config.MONITOR_INTERVAL_SECONDS}`);
    this.timer = setInterval(() => this.schedule(), 5000);
  }
  private schedule() {
    if (this.active) return;
    this.active = this.tick().then(result => {
      if (!result.skipped) this.logger.log(`Vesteda check succeeded: ${JSON.stringify(result)}`);
    }).catch((error: unknown) => {
      const category = error instanceof SourceError ? error.category : 'RUN_FAILED';
      require('../../scripts/telemetry.cjs').init().report(error, 'vesteda', category);
      this.logger.warn(`Vesteda check failed: category=${category}`);
    }).finally(() => { this.active = undefined; });
  }
  tick() {
    if (!this.config.VESTEDA_MONITORING_ENABLED) return Promise.resolve({ skipped: true as const });
    return runVesteda(this.db, this.listings, { destination: this.config.TELEGRAM_CHAT_ID,
      intervalSeconds: this.config.MONITOR_INTERVAL_SECONDS });
  }
  async onModuleDestroy() { clearInterval(this.timer); await this.active; }
}
