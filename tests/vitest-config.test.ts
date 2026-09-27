import { describe, expect, it } from 'vitest';

describe('the suite configuration', (): void => {
  it('runs every test in UTC whatever zone the machine is in', (): void => {
    expect(process.env.TZ).toBe('UTC');
    expect(new Date(Date.UTC(2026, 8, 27, 16, 30)).getHours()).toBe(16);
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC');
  });
});
