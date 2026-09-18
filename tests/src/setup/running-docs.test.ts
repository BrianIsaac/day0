import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { PROFILES } from '../../../scripts/compose';
import { REAL_MODE_PROFILES } from '../../../scripts/setup';

/**
 * `docs/running/components.md` is what an operator reads to decide which
 * components to start and which ports they will publish. The compose file and
 * the real-mode setup are what actually start them, so the page is pinned to
 * both: a profile added to one, a port moved in the other, or a knob the
 * backend is now started with has to reach the page before the gate is green.
 */

const COMPONENTS = readFileSync(
  new URL('../../../docs/running/components.md', import.meta.url),
  'utf8',
);
const COMPOSE = readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');

/** The host-port variables the compose file publishes, with their defaults. */
function publishedPorts(): Record<string, string> {
  const published: Record<string, string> = {};
  for (const [, name, fallback] of COMPOSE.matchAll(
    /\$\{(CONVEX_PORT|CONVEX_SITE_PROXY_PORT|CONVEX_DASHBOARD_PORT|MODEL_PORT|FAKE_SLACK_HOST_PORT):-(\d+)\}:/g,
  )) {
    published[name!] = fallback!;
  }
  return published;
}

/** A backend environment value the compose file sets, by name. */
function backendKnob(name: string): string {
  const found = new RegExp(`- ${name}=(\\S+)`).exec(COMPOSE);
  expect(found).not.toBeNull();
  return found![1]!;
}

describe('the components page', (): void => {
  it('names every profile the compose file defines, and no other', (): void => {
    for (const profile of Object.keys(PROFILES)) {
      expect(COMPONENTS).toContain(`\`${profile}\``);
    }
    for (const [, named] of COMPONENTS.matchAll(/--profile ([a-z-]+)/g)) {
      expect(Object.keys(PROFILES)).toContain(named!);
    }
  });

  it('says which profiles a real-mode setup starts for you', (): void => {
    for (const profile of REAL_MODE_PROFILES) {
      expect(COMPONENTS).toContain(`\`${profile}\``);
    }
    expect(COMPONENTS).toContain('./setup.sh');
  });

  it('lists every host port the compose file publishes, with its default', (): void => {
    const ports = publishedPorts();
    expect(Object.keys(ports).sort()).toEqual([
      'CONVEX_DASHBOARD_PORT',
      'CONVEX_PORT',
      'CONVEX_SITE_PROXY_PORT',
      'FAKE_SLACK_HOST_PORT',
      'MODEL_PORT',
    ]);
    for (const [name, fallback] of Object.entries(ports)) {
      expect(COMPONENTS).toContain(`\`${name}\``);
      expect(COMPONENTS).toContain(fallback);
    }
  });

  it('gives the scheduler knobs the backend is started with', (): void => {
    expect(COMPONENTS).toContain(
      `SCHEDULED_JOB_EXECUTION_PARALLELISM=${backendKnob('SCHEDULED_JOB_EXECUTION_PARALLELISM')}`,
    );
    expect(COMPONENTS).toContain(
      `APPLICATION_MAX_CONCURRENT_NODE_ACTIONS=${backendKnob('APPLICATION_MAX_CONCURRENT_NODE_ACTIONS')}`,
    );
  });

  it('says how the redactor is warmed rather than downloaded', (): void => {
    expect(COMPONENTS).toContain('--warm-from');
  });
});
