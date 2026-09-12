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
