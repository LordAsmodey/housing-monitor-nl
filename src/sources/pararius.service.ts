import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ListingsService } from '../listings/listings.service';
import { parseEnvironment } from '../config/environment';

const { runPararius } = require('../../scripts/pararius-runner.cjs');
const { SOURCE_ID, FundaError } = require('../../scripts/pararius-core.cjs');
const { browserClient } = require('../../scripts/funda-browser-client.cjs');

@Injectable()
export class ParariusService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ParariusService.name);
  private readonly config = parseEnvironment(process.env);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  constructor(private readonly db: PrismaService, private readonly listings: ListingsService) {}
  onModuleInit() {
    if (!this.config.PARARIUS_BROWSER_ORIGIN) return;
    this.logger.log(`Pararius automatic monitoring scheduled: intervalSeconds=${this.config.MONITOR_INTERVAL_SECONDS}`);
    this.timer = setInterval(() => this.schedule(), 5000);
  }
  private schedule() {
    if (this.active) return;
    this.active = this.tick().then((result: { skipped: boolean }) => {
      if (!result.skipped) this.logger.log(`Pararius check succeeded: ${JSON.stringify(result)}`);
    }).catch((error: unknown) => {
      const category = error instanceof FundaError ? (error as Error & { category: string }).category : 'RUN_FAILED';
      require('../../scripts/telemetry.cjs').init().report(error, 'pararius', category);
      this.logger.warn(`Pararius check failed: category=${category}`);
    }).finally(() => { this.active = undefined; });
  }
  async tick() {
    const search=await this.db.searchConfiguration.findUnique({where:{sourceId:SOURCE_ID}});
    if(search&&!search.enabled)return {skipped:true as const};
    if (!this.config.PARARIUS_BROWSER_ORIGIN) return { skipped: true };
    const client = browserClient(this.config.PARARIUS_BROWSER_ORIGIN, this.config.PARARIUS_BROWSER_TOKEN);
    const source = await this.db.source.findUnique({ where: { id: SOURCE_ID } });
    if (source?.status === 'BLOCKED') {
      const state = await client.state();
      if (state.humanCheck || state.accessDenied) { await this.enqueueRecovery(client); return { skipped: true }; }
      if (state.recovered && state.searchReady) {
        await this.db.source.updateMany({ where: { id: SOURCE_ID, status: 'BLOCKED', monitorLeaseToken: null },
          data: { status: 'DEGRADED', nextCheckAt: new Date() } });
      } else return { skipped: true };
    }
    try {
      return await runPararius(this.db, this.listings, { destination: this.config.TELEGRAM_CHAT_ID,
        intervalSeconds: this.config.MONITOR_INTERVAL_SECONDS, collector: client.collect });
    } catch (error) {
      if (error instanceof FundaError && ['HUMAN_CHECK', 'ACCESS_BLOCKED'].includes((error as Error & { category: string }).category)) {
        await this.enqueueRecovery(client);
      }
      throw error;
    }
  }
  private async enqueueRecovery(client: { recovery(): Promise<{ id: string; url: string }> }) {
    const recovery = await client.recovery();
    await this.db.notificationOutbox.createMany({ skipDuplicates: true, data: [{
      destinationRef: this.config.TELEGRAM_CHAT_ID, idempotencyKey: 'pararius-recovery:' + recovery.id,
      payload: 'Pararius просит проверку человека. Мониторинг приостановлен. Открой браузер, пройди проверку, нажми «Поиск жилья», затем «Сохранить сессию».\n' + recovery.url + '\nСсылка одноразовая, действует 24 часа. Не пересылай её.'
    }] });
  }
  async onModuleDestroy() { clearInterval(this.timer); await this.active; }
}
