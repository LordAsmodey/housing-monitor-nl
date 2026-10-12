import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ListingsService } from '../listings/listings.service';
import { parseEnvironment } from '../config/environment';

const { runFunda } = require('../../scripts/funda-runner.cjs') as {
  runFunda(db: PrismaService, listings: ListingsService, options: { destination: string; intervalSeconds: number; collector?: () => Promise<unknown>; browser?: boolean }):
    Promise<{ skipped: true } | { skipped: false; runId: string; inspected: number; matched: number; created: number; baseline: boolean }>;
};
const { FundaError } = require('../../scripts/funda-core.cjs') as {
  FundaError: new(category: string) => Error & { category: string };
};

const { browserClient } = require('../../scripts/funda-browser-client.cjs');

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
    const client = this.config.FUNDA_BROWSER_ORIGIN ? browserClient(this.config.FUNDA_BROWSER_ORIGIN,this.config.FUNDA_BROWSER_TOKEN) : undefined;
    const sourceId = 'funda:groningen-30km-1500-3d';
    if(client) {
      const source=await this.db.source.findUnique({where:{id:sourceId}});
      if(source?.status==='BLOCKED') {
        const state=await client.state();
        if(state.humanCheck || state.accessDenied) await this.enqueueRecovery(client);
        if(state.recovered && !state.humanCheck && !state.accessDenied && state.listingLinks>0) {
          await this.db.source.updateMany({where:{id:sourceId,status:'BLOCKED',monitorLeaseToken:null},data:{status:'DEGRADED',nextCheckAt:new Date()}});
        }
      }
    }
    try { return await runFunda(this.db, this.listings, { destination: this.config.TELEGRAM_CHAT_ID,
      intervalSeconds: this.config.MONITOR_INTERVAL_SECONDS, ...(client?{collector:client.collect,browser:true}:{}) });
    } catch(error) {
      if(client && error instanceof FundaError && ['HUMAN_CHECK','ACCESS_BLOCKED'].includes(error.category)) {
        await this.enqueueRecovery(client);
      }
      throw error;
    }
  }
  private async enqueueRecovery(client: {recovery(): Promise<{id:string;url:string}>}) {
    const recovery=await client.recovery();
    await this.db.notificationOutbox.createMany({skipDuplicates:true,data:[{
      destinationRef:this.config.TELEGRAM_CHAT_ID,idempotencyKey:'funda-recovery:'+recovery.id,
      payload:'Funda просит проверку человека. Мониторинг приостановлен. Открой браузер, пройди проверку, нажми «Поиск жилья», затем «Сохранить сессию».\n'+recovery.url+'\nСсылка одноразовая, действует 24 часа. Не пересылай её.'}]});
  }
  async onModuleDestroy() { clearInterval(this.timer); await this.active; }
}
