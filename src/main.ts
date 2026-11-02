import 'reflect-metadata';
import { parseBootstrapEnvironment } from './config/environment';
import { isStagingEnvironment } from './config/staging-isolation';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { resolve } from 'node:path';

let legacyTelemetryStarted = false;

async function bootstrap() {
  const config = parseBootstrapEnvironment(process.env);
  // Guard runs before telemetry and before importing any legacy application code.
  if (!isStagingEnvironment(process.env)) {
    await import('./instrument');
    legacyTelemetryStarted = true;
  }
  const { NestFactory } = await import('@nestjs/core');
  const module = isStagingEnvironment(process.env)
    ? (await import('./staging.module')).StagingModule
    : (await import('./app.module')).AppModule;
  const app = await NestFactory.create<NestExpressApplication>(module);
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
  if (!legacyTelemetryStarted) {
    console.error('Application startup refused; verify isolation configuration and dedicated database');
    process.exitCode = 1;
    return;
  }
  const telemetry = require('../scripts/telemetry.cjs').init();
  telemetry.report(error, 'application', 'STARTUP_FAILED');
  console.error('Application startup failed; check configuration and database connectivity');
  process.exitCode = 1;
  void telemetry.flush();
});
