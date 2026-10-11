import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get('live')
  live() {
    // Liveness only; this does not claim DB, Redis or sources are ready.
    return { status: 'ok', service: 'housing-monitor-nl' };
  }
}
