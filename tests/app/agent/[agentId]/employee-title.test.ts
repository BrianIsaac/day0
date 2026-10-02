import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redirect } from 'next/navigation';
import { describe, expect, it } from 'vitest';
import type { Id } from '../../../../convex/_generated/dataModel';
import { employeeTitle } from '../../../../app/agent/[agentId]/employee-title';

const AGENT = 'j57agent' as Id<'agents'>;

describe("the employee page's tab title (walk m16)", () => {
  it('names the employee before the tab, and Needs you on the page itself', async () => {
    expect(await employeeTitle(AGENT, async () => ({ kind: 'employee', name: 'Ada' }))).toEqual({
      default: 'Ada · Needs you · Day0',
      template: 'Ada · %s · Day0',
    });
  });

  it('leaves the name out when the manager cannot read it, and still titles the tab', async () => {
    expect(await employeeTitle(AGENT, async () => ({ kind: 'unnamed' }))).toEqual({
      default: 'Needs you · Day0',
      template: '%s · Day0',
    });
  });

  it('never fails the page over a name the backend could not give', async () => {
    const unreachable = async (): Promise<never> => {
      throw new Error('fetch failed');
    };
    expect(await employeeTitle(AGENT, unreachable)).toEqual({
      default: 'Needs you · Day0',
      template: '%s · Day0',
    });
  });

  it('titles every tab of an employee the manager handed over by where it went, never by a tab of theirs (the v0.12.0 walk)', async () => {
    expect(await employeeTitle(AGENT, async () => ({ kind: 'departed', name: 'Maya' }))).toEqual({
      default: 'Maya was handed over · Day0',
      template: 'Maya was handed over · Day0',
    });
  });

  it('titles every tab of a link that names no employee of the manager’s as the page does (the pre-tag walk W-3)', async () => {
    expect(await employeeTitle(AGENT, async () => ({ kind: 'none' }))).toEqual({
      default: 'No such employee · Day0',
      template: 'No such employee · Day0',
    });
  });

  it("hands Next's own redirect back to it rather than titling past it", async () => {
    const redirecting = async (): Promise<never> => redirect('/sign-in');
    await expect(employeeTitle(AGENT, redirecting)).rejects.toThrow('NEXT_REDIRECT');
  });
});

describe('where the tab title is read', () => {
  it('marks itself server-only, since it reads the deployment address and the session token (second review x10)', () => {
    const source = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../app/agent/[agentId]/employee-title.ts',
      ),
      'utf8',
    );
    expect(source.split('\n')[0]).toBe("import 'server-only';");
  });
});
