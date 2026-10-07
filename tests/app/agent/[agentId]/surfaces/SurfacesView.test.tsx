/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ queries: {} as Record<string, unknown> }));

vi.mock('convex/react', () => ({
  usePaginatedQuery: (reference: unknown) => ({
    results: (backend.queries[getFunctionName(reference as never)] as unknown[] | undefined) ?? [],
    status: 'Exhausted',
    loadMore: (): void => undefined,
  }),
  useQuery: (reference: unknown, args: unknown): unknown =>
    args === 'skip' ? undefined : backend.queries[getFunctionName(reference as never)],
  useMutation: () => async (): Promise<void> => undefined,
  useAction: () => async (): Promise<void> => undefined,
}));

import { SurfacesView } from '../../../../../app/agent/[agentId]/surfaces/SurfacesView';
import { asEmployee } from '../../../../fixtures/dom/employee';
import { mount, settle } from '../../../../fixtures/dom/press';

afterEach((): void => {
  backend.queries = {};
  document.body.replaceChildren();
});

describe('SurfacesView', () => {
  it('draws the work environment across the page, with the panel the #surfaces hash names', async () => {
    const view = mount(asEmployee(<SurfacesView />));
    await settle();
    await vi.waitFor(
      (): void => {
        expect(view.container.querySelector('#surfaces')).not.toBeNull();
      },
      { timeout: 15_000 },
    );
    expect(view.container.textContent).not.toContain('Permissions');
    expect(view.container.querySelector('[class*="lg:grid-cols"]')).toBeNull();
    view.unmount();
  }, 30_000);

  it('adds the permissions the manager granted in real mode', async () => {
    backend.queries = { 'agents:permissionScopes': [] };
    const view = mount(asEmployee(<SurfacesView />, { surfaceMode: 'real' }));
    await settle();
    expect(view.container.textContent).toMatch(/permission/i);
    view.unmount();
  });
});
