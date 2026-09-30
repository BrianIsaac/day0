import { afterEach, describe, expect, it } from 'vitest';
import {
  appConvexValues,
  appTalksTo,
  deployApp,
  readAppBack,
  setAppValues,
} from '../../../scripts/cloud/app';
import { readTarget, type CloudTarget } from '../../../scripts/cloud/checkout';
import {
  APP_URL,
  cleanupClouds,
  cloud,
  DEPLOYMENT,
  DEV_DEPLOYMENT,
  ran,
  type Cloud,
} from './harness';

afterEach(cleanupClouds);

/** The fake cloud's target, read as a verb reads it. */
function targetOf(c: Cloud): CloudTarget {
  const target = readTarget({ target: c.target }, c.io);
  if ('failure' in target) throw new Error(target.failure);
  return target;
}

describe('appConvexValues', (): void => {
  it('are the three values the app reads to find its deployment', (): void => {
    expect(Object.fromEntries(appConvexValues(DEPLOYMENT))).toEqual({
      NEXT_PUBLIC_CONVEX_URL: 'https://happy-otter-123.convex.cloud',
      NEXT_PUBLIC_CONVEX_SITE_URL: 'https://happy-otter-123.convex.site',
      CONVEX_DEPLOYMENT: 'prod:happy-otter-123',
    });
  });
});

describe('appTalksTo', (): void => {
  it('finds the deployment in a client chunk, and says no for another deployment', (): void => {
    expect(appTalksTo(cloud().io, APP_URL, DEPLOYMENT)).toEqual({ talks: true });
    expect(appTalksTo(cloud().io, APP_URL, DEV_DEPLOYMENT)).toEqual({ talks: false });
  });

  it('fails on a page that does not answer 200', (): void => {
    const c = cloud({ served: undefined });
    expect(appTalksTo(c.io, APP_URL, DEPLOYMENT)).toEqual({ failure: `${APP_URL}/ answered 404` });
  });
});

describe('setAppValues', (): void => {
  it('sends each value on stdin with --yes, never on the command line', (): void => {
    const c = cloud();
    expect(setAppValues(c.io, targetOf(c), new Map(c.state.vercelEnv))).toBeUndefined();
    const sets = c.calls.filter((call) => call.args[0] === 'env' && call.args[1] === 'update');
    expect(sets.map((call) => call.input)).toEqual([
      'https://happy-otter-123.convex.cloud',
      'https://happy-otter-123.convex.site',
      'prod:happy-otter-123',
    ]);
    expect(sets.every((call) => !call.args.some((arg) => arg.includes('convex.')))).toBe(true);
  });

  it('refuses when the listing does not show each value written by this run', (): void => {
    const c = cloud();
    const before = new Map(c.state.vercelEnv);
    before.set('CONVEX_DEPLOYMENT', 10_000);
    expect(setAppValues(c.io, targetOf(c), before)).toEqual({
      failure: "Vercel's listing does not show CONVEX_DEPLOYMENT written by this run",
    });
  });

  it('passes the scope the target names', (): void => {
    const c = cloud(
      {},
      { targetText: `CONVEX_DEPLOYMENT=prod:${DEPLOYMENT}\nVERCEL_SCOPE=team-a\n` },
    );
    expect(setAppValues(c.io, targetOf(c), new Map(c.state.vercelEnv))).toBeUndefined();
    expect(ran(c)[0]).toBe(
      'vercel env update NEXT_PUBLIC_CONVEX_URL production --yes --scope team-a',
    );
  });
});

describe('deployApp and readAppBack', (): void => {
  it('read back a new build that talks to the deployment and states the release', (): void => {
    const c = cloud({ stamp: { release: '0.3.0', commit: 'x' } });
    const before = {
      id: 'dpl_Before1',
      target: 'production',
      ready: true,
      url: undefined,
      aliases: [],
    };
    expect(deployApp(c.io, targetOf(c))).toEqual({ url: 'https://day0-after1.vercel.app' });
    expect(readAppBack(c.io, targetOf(c), APP_URL, before, '0.3.0')).toMatchObject({
      id: 'dpl_After1',
    });
  });

  it('refuse a /setup that states another release', (): void => {
    const c = cloud();
    expect(deployApp(c.io, targetOf(c))).toMatchObject({ url: expect.any(String) });
    expect(readAppBack(c.io, targetOf(c), APP_URL, undefined, '0.3.0')).toEqual({
      failure: `${APP_URL}/setup does not say the deployment behind it is at v0.3.0`,
    });
  });

  it('print the last lines of a deploy that failed', (): void => {
    const c = cloud({
      failing: [
        {
          match: 'vercel --prod',
          status: 1,
          stderr: 'Error: Command "pnpm run build" exited with 1',
        },
      ],
    });
    const failed = deployApp(c.io, targetOf(c));
    expect('failure' in failed && failed.failure).toContain(
      '  | Error: Command "pnpm run build" exited with 1',
    );
  });
});
