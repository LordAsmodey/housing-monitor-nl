import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { PrismaService } from './database/prisma.service';

// Deliberately no legacy module import: no collectors, sender, polling, admin
// mutation endpoints or browser recovery can be constructed in passive staging.
@Module({ controllers: [HealthController], providers: [PrismaService] })
export class StagingModule {}
