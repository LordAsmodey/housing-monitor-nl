import './instrument';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { parseEnvironment } from './config/environment';
import { NestExpressApplication } from '@nestjs/platform-express';
import { resolve } from 'node:path';

async function bootstrap() {
  const config = parseEnvironment(process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.use('/admin', (_req: unknown, res: {setHeader:(key:string,value:string)=>void}, next:()=>void) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    next();
  });
  app.useStaticAssets(resolve(process.cwd(), 'admin/dist'), {prefix:'/admin/'});
  app.enableShutdownHooks();
  await app.listen(config.PORT, '0.0.0.0');
}

void bootstrap().catch((error: unknown) => {
  const telemetry = require('../scripts/telemetry.cjs').init();
  telemetry.report(error, 'application', 'STARTUP_FAILED');
  console.error('Application startup failed; check configuration and database connectivity');
  process.exitCode = 1;
  void telemetry.flush();
});
