import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import type { Config } from './config.js';
import type { EventLogger } from './common/logger.js';

// Single place that builds the app, shared by main.ts and the e2e tests.
export async function createApp(config: Config, logger?: EventLogger): Promise<NestExpressApplication> {
  // Nest's own logger is limited to warnings and errors: no request or route logging.
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config, logger), {
    logger: config.logLevel === 'silent' ? false : ['error', 'warn'],
  });
  app.disable('x-powered-by');
  app.enableShutdownHooks();
  return app;
}
