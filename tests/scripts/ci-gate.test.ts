import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

it('runs the documented gate in order with development auth disabled for the build', () => {
  const workflow = parse(readFileSync('.github/workflows/gate.yml', 'utf8'));
  const commands = workflow.jobs.gate.steps
    .filter((step: { run?: string }) => step.run !== undefined)
    .map((step: { run: string }) => step.run.trim());

  expect(commands).toEqual([
    'pnpm install --frozen-lockfile',
    'pnpm lint',
    'pnpm typecheck',
    'pnpm test',
    'NEXT_PUBLIC_DEV_NO_AUTH= pnpm build',
  ]);
  expect(commands.at(-1)).toMatch(/^NEXT_PUBLIC_DEV_NO_AUTH= pnpm build$/);
});

it('runs every step in UTC, the zone the suite and the pinned backend image use', () => {
  const workflow = parse(readFileSync('.github/workflows/gate.yml', 'utf8'));
  expect(workflow.jobs.gate.env.TZ).toBe('UTC');
});

it('runs one exact Node 22 release, read from .nvmrc so a workstation can match it', () => {
  const workflow = parse(readFileSync('.github/workflows/gate.yml', 'utf8'));
  const setupNode = workflow.jobs.gate.steps.find((step: { uses?: string }) =>
    step.uses?.startsWith('actions/setup-node@'),
  );
  expect(setupNode.with['node-version-file']).toBe('.nvmrc');
  expect(setupNode.with['node-version']).toBeUndefined();
  expect(readFileSync('.nvmrc', 'utf8')).toMatch(/^22\.\d+\.\d+\n$/);
});

it('runs the browser job after the gate, from its own build, in UTC on the same Node', () => {
  const workflow = parse(readFileSync('.github/workflows/gate.yml', 'utf8'));
  const browser = workflow.jobs.browser;
  const commands = browser.steps
    .filter((step: { run?: string }) => step.run !== undefined)
    .map((step: { run: string }) => step.run.trim());

  expect(browser.needs).toBe('gate');
  expect(browser.env.TZ).toBe('UTC');
  expect(commands).toEqual([
    'pnpm install --frozen-lockfile',
    'pnpm exec playwright install --with-deps chromium',
    'NEXT_PUBLIC_DEV_NO_AUTH= pnpm build',
    'pnpm test:browser',
  ]);
  const setupNode = browser.steps.find((step: { uses?: string }) =>
    step.uses?.startsWith('actions/setup-node@'),
  );
  expect(setupNode.with['node-version-file']).toBe('.nvmrc');
  // A development Clerk key sends every page load to its handshake: the job's
  // placeholders are production-shaped, on a domain that cannot resolve.
  expect(browser.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY).toMatch(/^pk_live_/);
  expect(
    Buffer.from(browser.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.slice(8), 'base64').toString(),
  ).toMatch(/\.invalid\$$/);
});

it('checks the public pages at the two widths the floor names', async () => {
  const { default: config } = await import('../../playwright.config');
  expect(config.projects?.map((project) => [project.name, project.use?.viewport])).toEqual([
    ['desktop', { width: 1440, height: 900 }],
    ['phone', { width: 390, height: 844 }],
  ]);
  expect(config.testDir).toBe('tests/browser');
});
