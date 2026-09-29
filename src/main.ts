import 'reflect-metadata';
import { createApp } from './app.factory.js';
import { loadConfig } from './config.js';

async function bootstrap() {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.port, '0.0.0.0');
}

void bootstrap();
