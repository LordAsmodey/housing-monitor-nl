import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';

import { PrismaService } from './database/prisma.service';
import { ListingsService } from './listings/listings.service';
import { OutboxService } from './delivery/outbox.service';
import { FundaService } from './sources/funda.service';
import { ParariusService } from './sources/pararius.service';
import { HuurwoningenService } from './sources/huurwoningen.service';
import { WoldringService } from './sources/woldring.service';
import { GrunoService } from './sources/gruno.service';
import { SolideService } from './sources/solide.service';
import { RentbillyService } from './sources/rentbilly.service';
import { RotsvastService } from './sources/rotsvast.service';
import { Wonen123Service } from './sources/wonen123.service';
import { RentolaService } from './sources/rentola.service';
import { RentsolutionsService } from './sources/rentsolutions.service';
import { MaxxService } from './sources/maxx.service';
import { VandermeulenService } from './sources/vandermeulen.service';
import { LamberinkService } from './sources/lamberink.service';
import { VestedaService } from './sources/vesteda.service';
import { AdminController } from './admin/admin.controller';
import { AdminService } from './admin/admin.service';

@Module({ controllers: [HealthController, AdminController], providers: [PrismaService, ListingsService, OutboxService, ParariusService, FundaService, HuurwoningenService, WoldringService, VestedaService, GrunoService, LamberinkService, VandermeulenService, MaxxService, RentsolutionsService, Wonen123Service, RotsvastService, RentbillyService, RentolaService, SolideService, AdminService] })
export class AppModule {}

