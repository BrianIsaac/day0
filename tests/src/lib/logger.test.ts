import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../../../src/lib/logger';

afterEach((): void => {
  vi.restoreAllMocks();
});

describe('the logger', (): void => {
  it('writes one JSON line per call with the time, the level, the message and the fields', (): void => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string): void => {
      lines.push(line);
    });
    log.warn('exa research skipped', { role: 'revops', reason: 'no key' });
    log.error('sync failed', { sourceId: 's1' });
    expect(lines).toHaveLength(2);
    const [warned, errored] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(warned).toMatchObject({
      level: 'warn',
      msg: 'exa research skipped',
      role: 'revops',
      reason: 'no key',
    });
    expect(errored).toMatchObject({ level: 'error', msg: 'sync failed', sourceId: 's1' });
    expect(new Date(String(warned!.t)).getTime()).not.toBeNaN();
  });

  it('writes the four levels the export parser knows', (): void => {
    const levels: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string): void => {
      levels.push(String((JSON.parse(line) as { level: string }).level));
    });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(levels).toEqual(['debug', 'info', 'warn', 'error']);
  });
});
