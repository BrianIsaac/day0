/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../convex/_generated/dataModel';

const deploy = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());

vi.mock('convex/react', () => ({ useMutation: () => deploy }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import { DeployForm } from '../../../app/home/DeployForm';

const boss = { email: 'sam@revops.example', firstName: 'Sam' };
const sources = [
  { _id: 'source-handbook' as Id<'docSources'>, label: 'Handbook' },
  { _id: 'source-wiki' as Id<'docSources'>, label: 'Wiki' },
];

/** The form as a manager reads it, tags stripped. */
const readAs = (markup: string): string => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('DeployForm', (): void => {
  const html = renderToStaticMarkup(
    <DeployForm boss={boss} docSources={sources} surfaceMode="mock" pickerOpen />,
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

  it('states the three facts: who it reports to, where it works, how much it does alone', (): void => {
    expect(text).toContain('Reports to sam@revops.example (you)');
    expect(text).toContain(
      'Works in the mock office: a Slack, the Q4 Revenue Tracker, a wiki, a ticket queue and one social mention',
    );
    // Walk m4: the hosted office holds the manager DM too, so the mock copy says every action.
    expect(text).toContain(
      'Autonomy Supervised. In the hosted office every action waits for you, a message to you included, and applies once you approve its exact payload.',
    );
    const real = readAs(
      renderToStaticMarkup(
        <DeployForm boss={boss} docSources={[]} surfaceMode="real" pickerOpen />,
      ),
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
    expect(text).toContain(
      'Takes a few seconds. worker 1 will then ask you for a Day-1 one-to-one.',
    );
    expect(text).toContain(
      'Avatar art from the product’s own set, the Singapore Codex Pets gallery. No person is named here.',
    );
  });

  it('opens the faces for the first employee and keeps them folded for another', (): void => {
    expect(html).toMatch(/<details\b[^>]*\bopen=""/);
    const another = renderToStaticMarkup(
      <DeployForm boss={boss} docSources={sources} surfaceMode="mock" pickerOpen={false} />,
    );
    expect(another).not.toMatch(/<details\b[^>]*\bopen/);
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

  it('deploys the named employee with the chosen face and the unticked sources, then opens its page', async (): Promise<void> => {
    deploy.mockResolvedValue('agent-mira');
    act(() =>
      root.render(<DeployForm boss={boss} docSources={sources} surfaceMode="mock" pickerOpen />),
    );
    act(() => type(host.querySelector<HTMLInputElement>('input[type="text"]')!, '  Mira  '));
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Face 7"]')!.click());
    act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(host.textContent).toContain(
      'Takes a few seconds. Mira will then ask you for a Day-1 one-to-one.',
    );

    await act(async () => {
      host.querySelector('form')!.requestSubmit();
    });

    expect(deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        bossEmail: 'sam@revops.example',
        name: 'Mira',
        avatarId: 'face-07',
        excludedDocSourceIds: ['source-handbook'],
        zone: expect.any(String),
      }),
    );
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
    act(() =>
      root.render(<DeployForm boss={boss} docSources={[]} surfaceMode="mock" pickerOpen />),
    );
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
        <DeployForm
          boss={boss}
          docSources={[]}
          surfaceMode="mock"
          pickerOpen={false}
          focusOnMount
        />,
      ),
    );
    expect(document.activeElement).toBe(host.querySelector('input[type="text"]'));
    act(() => root.render(<></>));
    act(() =>
      root.render(<DeployForm boss={boss} docSources={[]} surfaceMode="mock" pickerOpen />),
    );
    expect(document.activeElement).toBe(document.body);
  });

  it('says why when the address cannot be read, and deploys nothing', async (): Promise<void> => {
    act(() =>
      root.render(
        <DeployForm
          boss={{ email: undefined, firstName: undefined }}
          docSources={[]}
          surfaceMode="mock"
          pickerOpen
        />,
      ),
    );
    await act(async () => {
      host.querySelector('form')!.requestSubmit();
    });
    expect(deploy).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not read your email address. Try signing out and back in.',
    );
  });

  it('keeps the form and says what failed when the deploy is refused', async (): Promise<void> => {
    deploy.mockRejectedValue(new Error('Deploy limit reached'));
    act(() =>
      root.render(<DeployForm boss={boss} docSources={[]} surfaceMode="mock" pickerOpen />),
    );
    await act(async () => {
      host.querySelector('form')!.requestSubmit();
    });
    expect(push).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Deploy limit reached');
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  });
});
