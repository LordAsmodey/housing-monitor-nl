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
  console.error(error instanceof Error ? error.message : 'Application startup failed');
  process.exitCode = 1;
});
