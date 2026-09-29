/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../../convex/_generated/dataModel';
import {
  PermissionRows,
  PermissionsCard,
} from '../../../../../app/agent/[agentId]/surfaces/PermissionsCard';
import { button, focusedName, mount, press, said } from '../../../../fixtures/dom/press';

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

describe('revoking and granting a permission from the card (step 45, P6-7)', (): void => {
  it('gives two scopes that differ only in punctuation two button ids', (): void => {
    const markup = renderToStaticMarkup(
      <PermissionRows
        scopes={[
          { scope: 'linear:write', active: true, source: 'deploy', grantedAt: 1, revokedAt: null },
          { scope: 'linear-write', active: true, source: 'manager', grantedAt: 1, revokedAt: null },
        ]}
        confirmingScope={null}
        busyScope={null}
        onAskRevoke={() => undefined}
        onCancelRevoke={() => undefined}
        onRevoke={() => undefined}
        onRegrant={() => undefined}
      />,
    );
    const ids = [...markup.matchAll(/<button[^>]* id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  afterEach((): void => {
    backend.queries = {};
    backend.refusals = {};
  });

  it('confirms a revoke with focus on the safe choice, says what it did, and gives focus back to the row', async (): Promise<void> => {
    backend.queries = {
      'agents:permissionScopes': [{ scope: 'linear:write', active: true, source: 'deploy' }],
    };
    const view = mount(<PermissionsCard agentId={'agent-1' as Id<'agents'>} />);
    await press(view.container, 'Revoke linear:write');
    expect(focusedName()).toBe('Keep grant');
    await press(view.container, 'Keep grant');
    expect(focusedName()).toBe('Revoke linear:write');

    await press(view.container, 'Revoke linear:write');
    await press(view.container, 'Confirm revoke');
    expect(said(view.container)).toEqual([
      'Revoked linear:write: work that still needs it stops at its final authority check.',
    ]);
    expect(focusedName()).toBe('Revoke linear:write');
    expect(view.container.querySelector('[role="group"]')).toBeNull();
    view.unmount();
  });

  it('says a refused re-grant, and gives every control a 44 px target', async (): Promise<void> => {
    backend.queries = {
      'agents:permissionScopes': [{ scope: 'slack:write', active: false, source: 'manager' }],
    };
    backend.refusals = {
      'agents:grantScopes': `[CONVEX M(agents:grantScopes)] [Request ID: 1] Server Error\nUncaught Error: slack:write is not a scope this employee can hold.\n    at handler (../convex/agents.ts:1:1)`,
    };
    const view = mount(<PermissionsCard agentId={'agent-1' as Id<'agents'>} />);
    expect(button(view.container, 'Re-grant slack:write').className).toMatch(/\bmin-h-11\b/);
    await press(view.container, 'Re-grant slack:write');
    expect(said(view.container)).toEqual(['slack:write is not a scope this employee can hold.']);
    expect(focusedName()).toBe('Re-grant slack:write');
    view.unmount();
  });
});
