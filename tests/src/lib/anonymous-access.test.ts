import { describe, expect, it } from 'vitest';
import { CALLERLESS_FUNCTIONS, NO_SESSION_ROUTES } from '../../../src/lib/anonymous-access';

describe('the functions and routes that answer with no caller', (): void => {
  it('names each function once, by its generated api path, with its reason', (): void => {
    const paths = CALLERLESS_FUNCTIONS.map((entry) => entry.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const entry of CALLERLESS_FUNCTIONS) {
      expect(entry.path).toMatch(/^[A-Za-z]+:[A-Za-z]+$/);
      expect(entry.reason.length, entry.path).toBeGreaterThan(40);
    }
  });

  it('lets only the release answer as a public fact', (): void => {
    const facts = CALLERLESS_FUNCTIONS.filter((entry) => entry.answer === 'public-fact');
    expect(facts.map((entry) => entry.path)).toEqual(['config:release']);
  });

  it('names each route and verb once, under app/api, with its reason', (): void => {
    const keys = NO_SESSION_ROUTES.map((route) => `${route.verb} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const route of NO_SESSION_ROUTES) {
      expect(route.path).toMatch(/^\/api(\/[a-z0-9-]+)+$/);
      expect(route.reason.length, route.path).toBeGreaterThan(20);
    }
  });
});
