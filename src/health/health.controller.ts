import { Controller, Get, Header } from '@nestjs/common';

@Controller('health')
export class HealthController {
  // Public route, so no counts: a pair count flipping 0 → 1 would tell anyone polling
  // that two people are talking right now. Counts go to the periodic `stats` log line only.
  @Get()
  @Header('Cache-Control', 'no-store')
  health() {
    return { ok: true };
  }
}
