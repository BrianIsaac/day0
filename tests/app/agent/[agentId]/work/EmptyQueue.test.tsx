/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../../convex/_generated/dataModel';
import { EmptyQueue } from '../../../../../app/agent/[agentId]/work/EmptyQueue';
import { axeViolations } from '../../../../fixtures/dom/axe';
import { button, mount, press, said } from '../../../../fixtures/dom/press';

const backend = vi.hoisted(() => ({
  standing: undefined as unknown,
  refusal: undefined as string | undefined,
  calls: [] as Array<{ name: string; args: unknown }>,
}));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown =>
    args === 'skip' || getFunctionName(reference as never) !== 'charterSeeding:standing'
      ? undefined
      : backend.standing,
  useMutation:
    (reference: unknown): ((args: unknown) => Promise<void>) =>
    async (args: unknown): Promise<void> => {
      backend.calls.push({ name: getFunctionName(reference as never), args });
      if (backend.refusal !== undefined) throw new Error(backend.refusal);
    },
}));

afterEach((): void => {
  backend.standing = undefined;
  backend.refusal = undefined;
  backend.calls = [];
  document.body.replaceChildren();
});

const AGENT = 'a1' as Id<'agents'>;
const STOPPED = {
  state: 'stopped',
  reason: 'the seeding did not finish within the ten minutes it is given',
  line: 'Day0 could not find work for Nola: the seeding did not finish within the ten minutes it is given.',
};

describe('the empty Work tab (12-J item 6, option C)', (): void => {
  it('asks for the charter before anything else, and reads no seeding', (): void => {
    backend.standing = STOPPED;
    const markup = renderToStaticMarkup(<EmptyQueue agentId={AGENT} charterApproved={false} />);
    expect(markup).toContain('Work arrives once you approve the charter.');
    expect(markup).not.toContain('Find work again');
  });

  it('offers Find work again once the seeding stopped, with no axe violation', async (): Promise<void> => {
    backend.standing = STOPPED;
    const view = mount(<EmptyQueue agentId={AGENT} charterApproved={true} />);
    expect(view.container.textContent).toContain(STOPPED.line);
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    view.unmount();
  });

  it('says the backend’s refusal when the press is refused', async (): Promise<void> => {
    backend.standing = STOPPED;
    backend.refusal = 'Day0 is still finding work for Nola.';
    const view = mount(<EmptyQueue agentId={AGENT} charterApproved={true} />);
    await press(view.container, 'Find work again');
    expect(backend.calls).toEqual([
      { name: 'charterSeeding:findWorkAgain', args: { agentId: AGENT } },
    ]);
    expect(said(view.container)).toEqual(['Day0 is still finding work for Nola.']);
    expect(button(view.container, 'Find work again')).toBeDefined();
    view.unmount();
  });
});
