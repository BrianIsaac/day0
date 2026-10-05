/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFunctionName, type FunctionReference } from 'convex/server';

/** Every mutation the hook sent, by function name, and how the next one answers. */
const sent = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; args: unknown }>,
  refuse: false,
}));

vi.mock('convex/react', () => {
  // Convex's `useMutation` answers one stable function per reference, as this does.
  const stable = new Map<string, (args: unknown) => Promise<unknown>>();
  return {
    useMutation: (reference: FunctionReference<'mutation'>) => {
      const name = getFunctionName(reference);
      const known = stable.get(name);
      if (known !== undefined) return known;
      const send = async (args: unknown): Promise<unknown> => {
        sent.calls.push({ name, args });
        if (sent.refuse) throw new Error('the backend refused');
        return { personId: null, identitiesAdded: 0 };
      };
      stable.set(name, send);
      return send;
    },
  };
});

import { useOwnerPerson } from '../../../app/home/use-owner-person';
import { log } from '../../../src/lib/logger';

function Probe({ label }: { readonly label: string }) {
  useOwnerPerson();
  return <p>{label}</p>;
}

afterEach((): void => {
  sent.calls = [];
  sent.refuse = false;
  vi.restoreAllMocks();
});

describe('useOwnerPerson', (): void => {
  it("asks the backend once per signed-in visit to keep the owner's own person, and not again on a re-render", async (): Promise<void> => {
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async (): Promise<void> => {
      root.render(<Probe label="first" />);
    });
    await act(async (): Promise<void> => {
      root.render(<Probe label="second" />);
    });
    expect(sent.calls).toEqual([{ name: 'people:ensureOwner', args: {} }]);
    expect(host.textContent).toBe('second');
    await act(async (): Promise<void> => {
      root.unmount();
    });
  });

  it('logs a refusal as a warning and leaves the page as it was', async (): Promise<void> => {
    sent.refuse = true;
    const warned = vi.spyOn(log, 'warn').mockImplementation((): void => undefined);
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async (): Promise<void> => {
      root.render(<Probe label="home" />);
    });
    expect(host.textContent).toBe('home');
    expect(warned).toHaveBeenCalledWith("the owner's own person was not kept", {
      reason: 'the backend refused',
    });
    await act(async (): Promise<void> => {
      root.unmount();
    });
  });
});
