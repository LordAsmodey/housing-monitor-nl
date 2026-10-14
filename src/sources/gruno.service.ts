import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ListingsService } from '../listings/listings.service';
import { parseEnvironment } from '../config/environment';
const { runGruno } = require('../../scripts/gruno-runner.cjs');
const { FundaError } = require('../../scripts/gruno-core.cjs');

@Injectable()
export class GrunoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GrunoService.name);
  private readonly config = parseEnvironment(process.env);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  constructor(private readonly db: PrismaService, private readonly listings: ListingsService) {}
  onModuleInit() {
    if (!this.config.GRUNO_MONITORING_ENABLED) {
      this.logger.log('Gruno monitoring disabled by configuration');
      return;
    }
    this.logger.log(`Gruno automatic monitoring scheduled: intervalSeconds=${this.config.MONITOR_INTERVAL_SECONDS}`);
    this.timer = setInterval(() => this.schedule(), 5000);
  }
  private schedule() {
    if (this.active) return;
    this.active = this.tick().then((result: { skipped: boolean }) => {
      if (!result.skipped) this.logger.log(`Gruno check succeeded: ${JSON.stringify(result)}`);
    }).catch((error: unknown) => {
      const category = error instanceof FundaError ? (error as Error & { category: string }).category : 'RUN_FAILED';
      require('../../scripts/telemetry.cjs').init().report(error, 'gruno', category);
      this.logger.warn(`Gruno check failed: category=${category}`);
    }).finally(() => { this.active = undefined; });
  }
  async tick() {
    if (!this.config.GRUNO_MONITORING_ENABLED) return { skipped: true };
    return runGruno(this.db, this.listings, {destination: this.config.TELEGRAM_CHAT_ID,
      intervalSeconds: this.config.MONITOR_INTERVAL_SECONDS});
  }
  async onModuleDestroy() { clearInterval(this.timer); await this.active; }
}
