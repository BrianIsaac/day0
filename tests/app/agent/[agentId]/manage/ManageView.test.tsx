/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Doc } from '../../../../../convex/_generated/dataModel';
import type { SurfaceRecord } from '../../../../../src/surfaces/types';
import { EmployeeContext } from '../../../../../app/agent/[agentId]/employee-context';
import { ManageView } from '../../../../../app/agent/[agentId]/manage/ManageView';

const backend = vi.hoisted(() => ({
  /** Mutations and actions that reject, by function name, with the text they reject with. */
  refusals: {} as Record<string, string>,
  /** What a mutation or action resolves with, by function name; undefined otherwise. */
  results: {} as Record<string, unknown>,
  /** Every call made, by function name, with its arguments. */
  calls: [] as Array<{ name: string; args: unknown }>,
  /** What a query answers, by function name; undefined (loading) otherwise. */
  queries: {} as Record<string, unknown>,
}));

vi.mock('convex/react', () => {
  const call =
    (reference: unknown): ((args?: unknown) => Promise<unknown>) =>
    async (args?: unknown): Promise<unknown> => {
      const name = getFunctionName(reference as never);
      backend.calls.push({ name, args });
      const refusal = backend.refusals[name];
      if (refusal !== undefined) throw new Error(refusal);
      return backend.results[name];
    };
  return {
    useQuery: (reference: unknown): unknown => backend.queries[getFunctionName(reference as never)],
    useMutation: call,
    useAction: call,
  };
});

describe('ManageView: the manager DM setting waits for a manager channel (N7)', (): void => {
  afterEach((): void => {
    backend.queries = {};
  });

  const agent = {
    _id: 'a1',
    _creationTime: 1,
    bossEmail: 'boss@day0.local',
    name: 'Priya',
    userId: 'owner',
    state: 'active',
    createdAt: 1,
  } as unknown as Doc<'agents'>;
  const approved = { approved: true } as unknown as Doc<'charters'>;

  /** The Manage tab as the shell hands it this employee. */
  function manage(
    surfaces: SurfaceRecord[],
    options: {
      mode?: 'mock' | 'real';
      charter?: Doc<'charters'> | null;
      state?: Doc<'agents'>['state'];
    } = {},
  ): string {
    return renderToStaticMarkup(
      <EmployeeContext
        value={{
          agent: { ...agent, state: options.state ?? agent.state },
          charter: options.charter === undefined ? approved : options.charter,
          surfaceMode: options.mode ?? 'real',
          surfaces,
          arriving: false,
          reportSentBack: () => undefined,
        }}
      >
        <ManageView />
      </EmployeeContext>,
    );
  }

  const channel = (): SurfaceRecord =>
    ({
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
      verdict: 'connected',
      credentialLanded: true,
      lastVerifiedAt: Date.now() - 60_000,
      managerDmChannelId: 'D0MANAGER',
      managerUserId: 'UMANAGER',
    }) as unknown as SurfaceRecord;

  it('is hidden until a chat surface has found the manager, then offered', (): void => {
    expect(manage([])).not.toMatch(/<select/);
    expect(manage([])).toContain('Once a chat surface finds your DM');
    const withChannel = manage([channel()]);
    expect(withChannel).toMatch(/<label[^>]*>Manager DMs<\/label>/);
    expect(withChannel).toMatch(/<select/);
  });

  it('offers the autonomy switch once the charter is approved, in real mode only', (): void => {
    expect(manage([])).toContain('role="switch"');
    const drafted = { approved: false } as unknown as Doc<'charters'>;
    const pending = { charter: drafted, state: 'charter-pending' as const };
    expect(manage([], pending)).not.toContain('role="switch"');
    expect(manage([], pending)).toContain('once Priya&#x27;s charter is approved');
    // A newer draft over the approved charter leaves the employee active, and the switch with it.
    expect(manage([], { charter: drafted })).toContain('role="switch"');
    const mock = manage([], { mode: 'mock' });
    expect(mock).not.toContain('role="switch"');
    expect(mock).toContain('every other write waits for your decision');
    expect(mock).not.toContain('Manager DMs');
  });
});
