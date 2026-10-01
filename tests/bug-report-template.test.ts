import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { SETUP_PAGE_URL } from '../src/setup/quickstart';

/** One field of a GitHub issue form's body. */
interface FormField {
  readonly type: string;
  readonly id?: string;
  readonly attributes: { readonly options?: readonly string[] };
}

const TEMPLATE = parse(
  readFileSync(new URL('../.github/ISSUE_TEMPLATE/bug_report.yml', import.meta.url), 'utf8'),
) as { readonly body: readonly FormField[] };

/** The ways of running Day0 a reporter picks from, as the form lists them. */
function routeOptions(): readonly string[] {
  const route = TEMPLATE.body.find((field) => field.id === 'route');
  expect(route?.type).toBe('dropdown');
  return route?.attributes.options ?? [];
}

/**
 * A reporter on the hosted demo picks it by the address in their browser bar,
 * so the option names the address the demo is served from, which is the
 * setup guide's own host.
 */
describe('the bug report form', (): void => {
  it('names the hosted demo by its own domain', (): void => {
    expect(routeOptions()).toContain('Hosted demo (dayzer0.dev)');
  });

  it('names the host the setup guide is served from', (): void => {
    const hosted = routeOptions().filter((option) => option.startsWith('Hosted demo'));
    expect(hosted).toEqual([`Hosted demo (${new URL(SETUP_PAGE_URL).host})`]);
  });
});
