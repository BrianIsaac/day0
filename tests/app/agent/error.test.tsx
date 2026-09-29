/** @vitest-environment jsdom */

import { ConvexError } from 'convex/values';
import { getFunctionName } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../convex/_generated/dataModel';
import EmployeePageError from '../../../app/agent/error';
import { EmployeeShell } from '../../../app/agent/[agentId]/EmployeeShell';
import { EMPLOYEE_NOT_YOURS } from '../../../src/agent/employee-access';
import { mount, press, settle } from '../../fixtures/dom/press';
import { SegmentBoundary } from '../../fixtures/dom/segment-boundary';

const backend = vi.hoisted(() => ({
  /** What a query answers, by function name; an `Error` is thrown in render as `useQuery` does. */
  queries: {} as Record<string, unknown>,
}));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args?: unknown): unknown => {
    if (args === 'skip') return undefined;
    const answer = backend.queries[getFunctionName(reference as never)];
    if (answer instanceof Error) throw answer;
    return answer;
  },
  useMutation: (): (() => Promise<void>) => async (): Promise<void> => undefined,
  useAction: (): (() => Promise<void>) => async (): Promise<void> => undefined,
}));

vi.mock('next/navigation', () => ({
  useSelectedLayoutSegment: (): null => null,
  useRouter: () => ({ replace: (): void => undefined }),
}));

/** Every read of the employee's the backend refuses the way it refuses this caller. */
function refusedWith(error: Error): Record<string, unknown> {
  return Object.fromEntries(
    [
      'agents:get',
      'charters:latest',
      'work:needsYouForAgent',
      'work:listForAgent',
      'skills:proposed',
      'metrics:forAgent',
    ].map((name) => [name, error]),
  );
}

/** The employee's route as Next draws it: the page-wide net around the layout's shell. */
function route() {
  return (
    <SegmentBoundary fallback={EmployeePageError}>
      <EmployeeShell agentId={'agent-1' as Id<'agents'>}>{null}</EmployeeShell>
    </SegmentBoundary>
  );
}

describe('the employee route with an id that names no employee of the caller', (): void => {
  beforeEach((): void => {
    // React reports every error a boundary catches; the report is not what these tests read.
    vi.spyOn(console, 'error').mockImplementation((): void => undefined);
  });

  afterEach((): void => {
    backend.queries = {};
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("reads 'No such employee' for a gone id, the net never reached", async (): Promise<void> => {
    backend.queries = {
      ...refusedWith(new Error('agent not found')),
      'agents:get': null,
      'config:surfaceMode': { mode: 'mock' },
    };
    const view = mount(route());
    await settle();
    expect(view.container.querySelector('h1')?.textContent).toBe('No such employee');
    expect(view.container.textContent).not.toContain('could not be drawn');
    view.unmount();
  });

  it("reads 'No such employee' for another owner's employee, through the net", async (): Promise<void> => {
    backend.queries = {
      ...refusedWith(new ConvexError(EMPLOYEE_NOT_YOURS)),
      'config:surfaceMode': { mode: 'mock' },
    };
    const view = mount(route());
    await settle();
    expect(view.container.querySelector('h1')?.textContent).toBe('No such employee');
    expect(view.container.textContent).toContain('the address names one that is not yours');
    view.unmount();
  });

  it('offers the read again for any other throw, and draws the page once it answers', async (): Promise<void> => {
    backend.queries = {
      ...refusedWith(new Error('[CONVEX Q(agents:get)] Server Error')),
      'config:surfaceMode': { mode: 'mock' },
    };
    const view = mount(route());
    await settle();
    expect(view.container.querySelector('h1')?.textContent).toBe('This page could not be drawn');

    backend.queries = { 'agents:get': null, 'config:surfaceMode': { mode: 'mock' } };
    await press(view.container, 'Try again');
    expect(view.container.querySelector('h1')?.textContent).toBe('No such employee');
    view.unmount();
  });
});
