import { afterEach, describe, expect, it } from 'vitest';
import {
  appConvexValues,
  appOnDeployment,
  appTalksTo,
  deployApp,
  frameworkRefusal,
  linkedProject,
  projectRefusal,
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
      NEXT_PUBLIC_CONVEX_URL: 'https://brisk-heron-417.convex.cloud',
      NEXT_PUBLIC_CONVEX_SITE_URL: 'https://brisk-heron-417.convex.site',
      CONVEX_DEPLOYMENT: 'prod:brisk-heron-417',
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
    expect(appTalksTo(c.io, APP_URL, DEPLOYMENT)).toEqual({
      failure: `${APP_URL}/ answered 404`,
      answered: 404,
    });
  });
});

describe('appOnDeployment', (): void => {
  it('says the app is on the deployment when a client chunk names it, and not for another', (): void => {
    expect(appOnDeployment(cloud().io, APP_URL, DEPLOYMENT)).toEqual({ on: true });
    expect(appOnDeployment(cloud().io, APP_URL, DEV_DEPLOYMENT)).toEqual({ on: false });
  });

  it('reads a home that answers not found as no app on it', (): void => {
    expect(appOnDeployment(cloud({ served: undefined }).io, APP_URL, DEPLOYMENT)).toEqual({
      on: false,
    });
  });

  it('fails on an HTTP error other than not found, an outage or a protected page, since then it cannot be told', (): void => {
    for (const code of ['503', '401']) {
      const c = cloud({
        failing: [
          { match: `%{http_code} ${APP_URL}/`, status: 0, stdout: `\n${code}`, stderr: '' },
        ],
      });
      expect(appOnDeployment(c.io, APP_URL, DEPLOYMENT)).toEqual({
        failure: `${APP_URL}/ answered ${code}`,
        answered: Number(code),
      });
    }
  });

  it('fails when nothing answers, since then it cannot be told', (): void => {
    const c = cloud({
      failing: [
        {
          match: `%{http_code} ${APP_URL}/`,
          status: 6,
          stdout: '\n000',
          stderr: 'curl: (6) Could not resolve host: day0-example.vercel.app',
        },
      ],
    });
    expect(appOnDeployment(c.io, APP_URL, DEPLOYMENT)).toEqual({
      failure: `${APP_URL}/ answered 000`,
    });
  });
});

describe('frameworkRefusal', (): void => {
  it('accepts a linked project built as Next.js and names any other preset', (): void => {
    expect(frameworkRefusal(cloud().io, targetOf(cloud()))).toBeUndefined();
    const other = cloud({ framework: 'Other' });
    expect(frameworkRefusal(other.io, targetOf(other))?.failure).toContain(
      'the Vercel project day0 has the framework preset Other',
    );
  });

  it('refuses when the link names no project, or the project cannot be read', (): void => {
    const unlinked = cloud({}, { linked: false });
    expect(frameworkRefusal(unlinked.io, targetOf(unlinked))?.failure).toContain(
      '.vercel/project.json does not name the linked project',
    );
    const unreadable = cloud({
      failing: [{ match: 'vercel project inspect', status: 1, stderr: 'Error: Not authorized' }],
    });
    expect(frameworkRefusal(unreadable.io, targetOf(unreadable))?.failure).toBe(
      '`vercel project inspect` named no framework preset for day0 (exit 1: Error: Not authorized).',
    );
  });
});

describe('setAppValues', (): void => {
  it('sends each value on stdin with --yes, never on the command line', (): void => {
    const c = cloud();
    expect(setAppValues(c.io, targetOf(c), new Map(c.state.vercelEnv))).toBeUndefined();
    const sets = c.calls.filter((call) => call.args[0] === 'env' && call.args[1] === 'update');
    expect(sets.map((call) => call.input)).toEqual([
      'https://brisk-heron-417.convex.cloud',
      'https://brisk-heron-417.convex.site',
      'prod:brisk-heron-417',
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
    const c = cloud({ stamp: { release: '0.4.0', commit: 'x' } });
    const before = {
      id: 'dpl_Before1',
      name: 'day0',
      target: 'production',
      ready: true,
      url: undefined,
      aliases: [],
    };
    expect(deployApp(c.io, targetOf(c))).toEqual({ url: 'https://day0-after1.vercel.app' });
    expect(readAppBack(c.io, targetOf(c), APP_URL, before, '0.4.0')).toMatchObject({
      id: 'dpl_After1',
    });
  });

  it('refuse a /setup that states another release', (): void => {
    const c = cloud();
    expect(deployApp(c.io, targetOf(c))).toMatchObject({ url: expect.any(String) });
    expect(readAppBack(c.io, targetOf(c), APP_URL, undefined, '0.4.0')).toEqual({
      failure: `${APP_URL}/setup does not say the deployment behind it is at v0.4.0`,
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

describe('projectRefusal', (): void => {
  it('accepts the build of the project the checkout is linked to, and refuses another', (): void => {
    const c = cloud();
    const served = {
      id: 'dpl_X',
      name: 'day0',
      target: 'production',
      ready: true,
      url: undefined,
      aliases: [],
    };
    expect(linkedProject(c.io)).toBe('day0');
    expect(projectRefusal(c.io, served, APP_URL)).toBeUndefined();
    expect(projectRefusal(c.io, { ...served, name: 'day0-staging' }, APP_URL)?.failure).toBe(
      `${APP_URL} is served by the Vercel project day0-staging, and this checkout is linked to day0; the writes would reach the linked one. Link the project that serves it: vercel link.`,
    );
  });
});
