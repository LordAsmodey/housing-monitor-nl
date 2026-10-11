import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';

import { PrismaService } from './database/prisma.service';
import { ListingsService } from './listings/listings.service';
import { OutboxService } from './delivery/outbox.service';

@Module({ controllers: [HealthController], providers: [PrismaService, ListingsService, OutboxService] })
export class AppModule {}
