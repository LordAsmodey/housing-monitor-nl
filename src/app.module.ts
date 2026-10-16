import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';

import { PrismaService } from './database/prisma.service';
import { ListingsService } from './listings/listings.service';
import { OutboxService } from './delivery/outbox.service';
import { FundaService } from './sources/funda.service';
import { HuurwoningenService } from './sources/huurwoningen.service';
import { WoldringService } from './sources/woldring.service';
import { GrunoService } from './sources/gruno.service';
import { SolideService } from './sources/solide.service';
import { MaxxService } from './sources/maxx.service';
import { VandermeulenService } from './sources/vandermeulen.service';
import { LamberinkService } from './sources/lamberink.service';
import { VestedaService } from './sources/vesteda.service';
import { AdminController } from './admin/admin.controller';
import { AdminService } from './admin/admin.service';

@Module({ controllers: [HealthController, AdminController], providers: [PrismaService, ListingsService, OutboxService, FundaService, HuurwoningenService, WoldringService, VestedaService, GrunoService, LamberinkService, VandermeulenService, MaxxService, SolideService, AdminService] })
export class AppModule {}

