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
