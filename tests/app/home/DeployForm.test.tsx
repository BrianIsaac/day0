/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../convex/_generated/dataModel';

const deploy = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());
/** What `agents.myManagerAddress` answers: undefined while it loads, null for no verified address. */
const server = vi.hoisted((): { address: string | null | undefined } => ({
  address: 'sam@revops.example',
}));

vi.mock('convex/react', () => ({ useMutation: () => deploy, useQuery: () => server.address }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import { ConvexError } from 'convex/values';
import { DeployForm } from '../../../app/home/DeployForm';
import { UNVERIFIED_FOR_DEPLOY } from '../../../src/agent/manager-address';
import { underTarget } from '../../fixtures/dom/targets';

// The browser's own word for the address (Clerk's client value), which the form no longer takes,
// shows or sends: the address is the server's verified one (9-U1), and its dead prop is gone (9-U4).
const BROWSER_ADDRESS = 'browser@elsewhere.example';
const sources = [
  { _id: 'source-handbook' as Id<'docSources'>, label: 'Handbook' },
  { _id: 'source-wiki' as Id<'docSources'>, label: 'Wiki' },
];

/** The form as a manager reads it, tags stripped. */
const readAs = (markup: string): string => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('DeployForm', (): void => {
  const html = renderToStaticMarkup(
    <DeployForm docSources={sources} surfaceMode="mock" pickerOpen />,
  );
  const text = readAs(html);

  it('asks for a new employee, in the manager’s word for it (N29)', (): void => {
    expect(text).toContain('Deploy a new Day0 employee');
    expect(text).toContain('Documentation this employee reads');
    expect(text).not.toMatch(/\bagent\b/i);
  });

  it('puts the faces above the name field, labelled, with the name’s help beneath it', (): void => {
    expect(html.indexOf('Choose avatar')).toBeLessThan(html.indexOf('>Name</label>'));
    const label = /<label for="([^"]+)"[^>]*>Name<\/label>/.exec(html)?.[1];
    expect(label).toBeTruthy();
    expect(html).toContain(`id="${label}"`);
    expect(text).toContain('The name the team will see. It cannot be changed after deploy.');
  });

  it("keeps the base layer's focus ring on the name field, which no utility of its own removes (C1)", (): void => {
    const field = /<input[^>]*placeholder="worker 1"[^>]*>/.exec(html)?.[0] ?? '';
    expect(field).toContain('focus:border-[var(--color-accent)]');
    expect(field).not.toMatch(/outline-(none|hidden)/);
  });

  it('takes a name of at most 80 characters, the bound the deploy holds it to', (): void => {
    const field = /<input[^>]*placeholder="worker 1"[^>]*>/.exec(html)?.[0] ?? '';
    expect(field).toContain('maxLength="80"');
  });

  it('states the three facts: who it reports to, where it works, how much it does alone', (): void => {
    // The server's verified address, never the browser's.
    expect(text).toContain('Reports to sam@revops.example (you)');
    expect(text).not.toContain(BROWSER_ADDRESS);
    expect(text).toContain(
      'Works in the mock office: a Slack, the Q4 Revenue Tracker, a wiki, a ticket queue and one social mention',
    );
    // Walk m4: the hosted office holds the manager DM too, so the mock copy says every action.
    expect(text).toContain(
      'Autonomy Supervised. In the hosted office every action waits for you, a message to you included, and applies once you approve its exact payload.',
    );
    const real = readAs(
      renderToStaticMarkup(<DeployForm docSources={[]} surfaceMode="real" pickerOpen />),
    );
    expect(real).toContain(
      'Works in the systems it finds in your documentation, each connected only once you approve it',
    );
    expect(real).toContain(
      'Autonomy Supervised. Reads and messages to you apply on their own; every other action waits for your approval of the exact payload.',
    );
  });

  it('says beside the button what happens next, and credits the faces without naming anyone', (): void => {
    expect(html).toMatch(/<button type="submit"[^>]*>Deploy<\/button>/);
    expect(text).toContain('Takes a few seconds, then worker 1 asks you for a Day-1 one-to-one.');
    expect(text).toContain(
      'Avatar art from the product’s own set, the Singapore Codex Pets gallery. No person is named here.',
    );
  });

  it('opens the faces for the first employee and keeps them folded for another', (): void => {
    expect(html).toMatch(/<details\b[^>]*\bopen=""/);
    const another = renderToStaticMarkup(
      <DeployForm docSources={sources} surfaceMode="mock" pickerOpen={false} />,
    );
    expect(another).not.toMatch(/<details\b[^>]*\bopen/);
  });

  it("gives every control a 44 px target, the Deploy button, the name field and each source's box included (11-AC's cockpit item 10)", (): void => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <DeployForm docSources={sources} surfaceMode="real" pickerOpen onCancel={() => undefined} />,
    );
    // The faces are 48 px tall (`h-12`), which the helper's class rule does not read.
    const faces = host.querySelector('details');
    expect(faces?.querySelectorAll('button.h-12').length).toBeGreaterThan(0);
    faces?.remove();
    expect(underTarget(host)).toEqual([]);
  });

  it('sets no type below the 12 px floor', (): void => {
    expect(html).not.toMatch(/text-\[(9|10|11)px\]/);
  });
});

describe('DeployForm, deploying', (): void => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach((): void => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    deploy.mockReset();
    push.mockReset();
    server.address = 'sam@revops.example';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 202 })),
    );
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach((): void => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const type = (input: HTMLInputElement, value: string): void => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  it('names no one in the line beside the button once the name field is emptied', (): void => {
    act(() => root.render(<DeployForm docSources={sources} surfaceMode="mock" pickerOpen />));
    act(() => type(host.querySelector<HTMLInputElement>('input[type="text"]')!, ''));
    expect(host.textContent).toContain(
      'Takes a few seconds, then your new employee asks you for a Day-1 one-to-one.',
    );
  });

  it('deploys the named employee with the chosen face and the unticked sources, then opens its page', async (): Promise<void> => {
    deploy.mockResolvedValue('agent-mira');
    act(() => root.render(<DeployForm docSources={sources} surfaceMode="mock" pickerOpen />));
    act(() => type(host.querySelector<HTMLInputElement>('input[type="text"]')!, '  Mira  '));
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Face 7"]')!.click());
    act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(host.textContent).toContain(
      'Takes a few seconds, then Mira asks you for a Day-1 one-to-one.',
    );

    await act(async () => {
      host.querySelector('form')!.requestSubmit();
    });

    expect(deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Mira',
        avatarId: 'face-07',
        excludedDocSourceIds: ['source-handbook'],
        zone: expect.any(String),
      }),
    );
    // The address is the caller's own verified one, read on the server: the form sends none.
    expect(deploy.mock.calls[0]?.[0]).not.toHaveProperty('bossEmail');
    expect(push).toHaveBeenCalledWith('/agent/agent-mira');
  });

  it('opens the new page even when the mock seed cannot be sent, and logs why', async (): Promise<void> => {
    deploy.mockResolvedValue('agent-mira');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    const lines = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    act(() => root.render(<DeployForm docSources={[]} surfaceMode="mock" pickerOpen />));
    await act(async () => {
      host.querySelector('form')!.requestSubmit();
    });
    expect(push).toHaveBeenCalledWith('/agent/agent-mira');
    const logged = lines.mock.calls.map(([line]) => JSON.parse(String(line)) as object);
    expect(logged).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        msg: 'mock seed not sent',
        agentId: 'agent-mira',
        reason: 'offline',
      }),
    );
    lines.mockRestore();
  });

  it('puts the caret in the name field when opened as Deploy another, and not otherwise', (): void => {
    act(() =>
      root.render(
        <DeployForm docSources={[]} surfaceMode="mock" pickerOpen={false} focusOnMount />,
      ),
    );
    expect(document.activeElement).toBe(host.querySelector('input[type="text"]'));
    act(() => root.render(<></>));
    act(() => root.render(<DeployForm docSources={[]} surfaceMode="mock" pickerOpen />));
    expect(document.activeElement).toBe(document.body);
  });

  it('says why at once when the sign-in carries no verified address, and offers no deploy', async (): Promise<void> => {
    server.address = null;
    act(() => root.render(<DeployForm docSources={[]} surfaceMode="mock" pickerOpen />));
    expect(host.querySelector('dl dd')?.textContent).toBe('no verified address');
    // Before any click: the reason is on the form, announced, and the button is held.
    const reason = host.querySelector('[role="status"]');
    expect(reason?.textContent).toBe(UNVERIFIED_FOR_DEPLOY);
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await act(async () => {
      host.querySelector('form')!.requestSubmit();
    });
    expect(deploy).not.toHaveBeenCalled();
  });

  it('holds the button while the address loads, and says so in the facts', (): void => {
    server.address = undefined;
    act(() => root.render(<DeployForm docSources={[]} surfaceMode="mock" pickerOpen />));
    expect(host.querySelector('dl dd')?.textContent).toBe('loading');
    expect(host.querySelector('dl dd')?.getAttribute('aria-live')).toBe('polite');
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  });

  it("shows the server's refusal in its own words, not the transport's", async (): Promise<void> => {
    // As the Convex client raises it: the data is the words, the message carries the transport's.
    const refusal = Object.assign(new ConvexError(UNVERIFIED_FOR_DEPLOY), {
      message: `[CONVEX M(agents:deploy)] [Request ID: 1] Server Error\nUncaught ConvexError: ${UNVERIFIED_FOR_DEPLOY}`,
    });
    deploy.mockRejectedValue(refusal);
    act(() => root.render(<DeployForm docSources={[]} surfaceMode="mock" pickerOpen />));
    await act(async () => {
      host.querySelector('form')!.requestSubmit();
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(UNVERIFIED_FOR_DEPLOY);
  });

  it('keeps the form and says what failed when the deploy is refused', async (): Promise<void> => {
    deploy.mockRejectedValue(new Error('Deploy limit reached'));
    act(() => root.render(<DeployForm docSources={[]} surfaceMode="mock" pickerOpen />));
    await act(async () => {
      host.querySelector('form')!.requestSubmit();
    });
    expect(push).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Deploy limit reached');
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  });
});
