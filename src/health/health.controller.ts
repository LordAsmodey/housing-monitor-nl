import { PrismaService } from '../database/prisma.service';
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

@Controller('health')
export class HealthController {
  constructor(private readonly db: PrismaService) {}
  @Get('ready')
  async ready() {
    try { await this.db.$queryRaw`SELECT 1 FROM "NotificationOutbox" LIMIT 1`; }
    catch { throw new ServiceUnavailableException('Database unavailable or migrations missing'); }
    return { status: 'ok', database: 'ready' };
  }

  @Get('live')
  live() {
    // Liveness only; this does not claim DB, Redis or sources are ready.
    return { status: 'ok', service: 'housing-monitor-nl' };
  }
}
