import './instrument';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { parseEnvironment } from './config/environment';

async function bootstrap() {
  const config = parseEnvironment(process.env);
  const app = await NestFactory.create(AppModule);
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
