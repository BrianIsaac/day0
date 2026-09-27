import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const OVERLAY = readFileSync(new URL('../docker-compose.gpu.yml', import.meta.url), 'utf8');

describe('docker-compose.gpu.yml', (): void => {
  it('gives a hand recipe that reads the env file the base compose file interpolates from', (): void => {
    const recipe = OVERLAY.split('\n')
      .filter((line) => line.startsWith('#   '))
      .join(' ');
    expect(recipe).toContain('docker compose --env-file .env.local');
    expect(recipe).toContain('-f docker-compose.yml -f docker-compose.gpu.yml');
  });
});
