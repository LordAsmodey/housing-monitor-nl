import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';

import { PrismaService } from './database/prisma.service';
import { ListingsService } from './listings/listings.service';
import { OutboxService } from './delivery/outbox.service';
import { FundaService } from './sources/funda.service';
import { HuurwoningenService } from './sources/huurwoningen.service';
import { WoldringService } from './sources/woldring.service';
import { GrunoService } from './sources/gruno.service';
import { LamberinkService } from './sources/lamberink.service';
import { VestedaService } from './sources/vesteda.service';
import { AdminController } from './admin/admin.controller';
import { AdminService } from './admin/admin.service';

@Module({ controllers: [HealthController, AdminController], providers: [PrismaService, ListingsService, OutboxService, FundaService, HuurwoningenService, WoldringService, VestedaService, GrunoService, LamberinkService, AdminService] })
export class AppModule {}

