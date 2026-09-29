import { type DynamicModule, Module } from '@nestjs/common';
import { CONFIG, type Config } from './config.js';
import { createLogger, type EventLogger, LOGGER } from './common/logger.js';
import { HealthController } from './health/health.controller.js';
import { RelayServer } from './relay/relay.server.js';
import { RelayService, systemClock } from './relay/relay.service.js';

@Module({})
export class AppModule {
  static register(config: Config, logger: EventLogger = createLogger(config.logLevel)): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: LOGGER, useValue: logger },
        {
          provide: RelayService,
          useFactory: (cfg: Config, log: EventLogger) => new RelayService(cfg, systemClock, log),
          inject: [CONFIG, LOGGER],
        },
        RelayServer,
      ],
    };
  }
}
