import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';

import { PrismaService } from './database/prisma.service';
import { ListingsService } from './listings/listings.service';
import { OutboxService } from './delivery/outbox.service';
import { FundaService } from './sources/funda.service';
import { HuurwoningenService } from './sources/huurwoningen.service';
import { WoldringService } from './sources/woldring.service';
import { GrunoService } from './sources/gruno.service';
import { VestedaService } from './sources/vesteda.service';

@Module({ controllers: [HealthController], providers: [PrismaService, ListingsService, OutboxService, FundaService, HuurwoningenService, WoldringService, VestedaService, GrunoService] })
export class AppModule {}

