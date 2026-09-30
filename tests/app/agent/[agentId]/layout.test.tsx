/** @vitest-environment jsdom */

import { Component, isValidElement, type ReactNode } from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EmployeeLayout from '../../../../app/agent/[agentId]/layout';
import { EmployeeShell } from '../../../../app/agent/[agentId]/EmployeeShell';
import { SessionGate } from '../../../../app/Providers';
import { mount, unmountAll } from '../../../fixtures/dom/press';
import { EMPLOYEE_ROW } from '../../../fixtures/dom/employee';
import { syncServer, type ClientMessage } from '../../../fixtures/convex/sync-socket';

/** Clerk as the page sees it: loading until the test says it has answered. */
const clerk = vi.hoisted(() => {
  interface ClerkAuth {
    readonly isLoaded: boolean;
    readonly isSignedIn?: boolean;
    readonly sessionId?: string;
    readonly getToken: () => Promise<string>;
  }
  const listeners = new Set<() => void>();
  // Clerk's `getToken` is one function from the first render, before its script has answered.
  const getToken = async (): Promise<string> => {
    const part = (value: object): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    return `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ sub: 'user_1', iat: now, exp: now + 3600 })}.c2ln`;
  };
  let auth: ClerkAuth = { isLoaded: false, getToken };
  return {
    getToken,
    read: (): ClerkAuth => auth,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    answer: (next: ClerkAuth): void => {
      auth = next;
      for (const listener of listeners) listener();
    },
  };
});

vi.mock('@clerk/nextjs', async () => {
  const { useSyncExternalStore } = await import('react');
  const useClerkAuth = () => useSyncExternalStore(clerk.subscribe, clerk.read, clerk.read);
  return {
    ClerkProvider: ({ children }: { children: ReactNode }) => children,
    useAuth: useClerkAuth,
    useClerk: () => ({ status: useClerkAuth().isLoaded ? 'ready' : 'loading' }),
  };
});

vi.mock('next/navigation', () => ({
  useSelectedLayoutSegment: (): null => null,
  useRouter: () => ({ replace: (): void => undefined }),
}));

/** What the app's error boundary would show: the page did not load. */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render(): ReactNode {
    return this.state.error ? <p>This page did not load</p> : this.props.children;
  }
}

/** Let the socket open and every message between the client and the deployment land. */
async function exchange(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await act(async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

function addsOf(message: ClientMessage): string[] {
  if (message.type !== 'ModifyQuerySet') return [];
  return (message.modifications as ReadonlyArray<{ type: string; udfPath?: string }>)
    .filter((change) => change.type === 'Add')
    .map((change) => change.udfPath ?? '');
}

afterEach(() => {
  unmountAll();
  clerk.answer({ isLoaded: false, getToken: clerk.getToken });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the employee page layout', () => {
  it("puts the open tab's page inside the shell of the employee the route names, behind the session gate", async () => {
    const child = <p>tab</p>;
    const element = await EmployeeLayout({
      children: child,
      params: Promise.resolve({ agentId: 'j57agent' }),
    });
    expect(isValidElement(element)).toBe(true);
    expect(element.type).toBe(SessionGate);
    const shell = (element.props as { children: ReactNode }).children;
    expect(isValidElement(shell)).toBe(true);
    expect((shell as { type: unknown }).type).toBe(EmployeeShell);
    expect((shell as { props: unknown }).props).toEqual({ agentId: 'j57agent', children: child });
  });

  it("titles each tab's page by the tab's label, under the layout's template (walk m16)", async () => {
    const tabs = [
      'work',
      'charter',
      'people',
      'documentation',
      'skills',
      'surfaces',
      'record',
      'manage',
    ] as const;
    const { EMPLOYEE_TAB_LABELS } = await import('../../../../app/agent/[agentId]/employee-tabs');
    for (const tab of tabs) {
      const page = (await import(`../../../../app/agent/[agentId]/${tab}/page.tsx`)) as {
        metadata?: { title?: unknown };
      };
      expect(page.metadata?.title, tab).toBe(EMPLOYEE_TAB_LABELS[tab]);
    }
    const root = (await import('../../../../app/agent/[agentId]/page')) as {
      metadata?: unknown;
    };
    // The page itself takes the layout's default, "<name> · Needs you · Day0".
    expect(root.metadata).toBeUndefined();
  });

  it('asks for the employee only once Convex holds the token, so a full load never reaches the error boundary (walk M2)', async () => {
    const server = syncServer((path, signedIn) => {
      if (path === 'config:surfaceMode') return { value: { mode: 'mock' } };
      if (path !== 'agents:get') return undefined;
      return signedIn ? { value: EMPLOYEE_ROW } : { error: 'not authenticated' };
    });
    vi.stubGlobal('WebSocket', server.Socket);
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://full-load-test.convex.cloud');
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', undefined);
    const { Providers } = await import('../../../../app/Providers');
    const { default: Layout } = await import('../../../../app/agent/[agentId]/layout');
    const page = await Layout({
      children: <p>tab</p>,
      params: Promise.resolve({ agentId: EMPLOYEE_ROW._id }),
    });

    const { container } = mount(
      <Providers>
        <Boundary>{page}</Boundary>
      </Providers>,
    );
    // The page is served and hydrated while Clerk's script is still on its way.
    await exchange();
    expect(container.textContent).not.toContain('This page did not load');
    expect(server.sent.flatMap(addsOf)).not.toContain('agents:get');

    act((): void => clerk.answer({ isLoaded: true, isSignedIn: true, getToken: clerk.getToken }));
    await exchange();

    expect(container.textContent).not.toContain('This page did not load');
    expect(container.querySelector('nav[aria-label="Breadcrumb"]')?.textContent).toContain('Mira');
    const signedInAt = server.sent.findIndex(
      (message) => message.type === 'Authenticate' && message.tokenType === 'User',
    );
    const askedAt = server.sent.findIndex((message) => addsOf(message).includes('agents:get'));
    expect(signedInAt).toBeGreaterThanOrEqual(0);
    expect(askedAt).toBeGreaterThan(signedInAt);
  });

  it('keeps the page and its token while Clerk re-resolves the session mid-visit', async () => {
    const server = syncServer((path, signedIn) => {
      if (path === 'config:surfaceMode') return { value: { mode: 'mock' } };
      if (path !== 'agents:get') return undefined;
      return signedIn ? { value: EMPLOYEE_ROW } : { error: 'not authenticated' };
    });
    vi.stubGlobal('WebSocket', server.Socket);
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://re-resolve-test.convex.cloud');
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', undefined);
    const { Providers } = await import('../../../../app/Providers');
    const { default: Layout } = await import('../../../../app/agent/[agentId]/layout');
    const page = await Layout({
      children: <p>tab</p>,
      params: Promise.resolve({ agentId: EMPLOYEE_ROW._id }),
    });
    act((): void => clerk.answer({ isLoaded: true, isSignedIn: true, getToken: clerk.getToken }));
    const { container } = mount(
      <Providers>
        <Boundary>{page}</Boundary>
      </Providers>,
    );
    await exchange();
    const breadcrumb = (): string | undefined =>
      container.querySelector('nav[aria-label="Breadcrumb"]')?.textContent ?? undefined;
    expect(breadcrumb()).toContain('Mira');

    // Clerk refreshing an expiring session answers "not loaded" again for a moment.
    act((): void => clerk.answer({ isLoaded: false, getToken: clerk.getToken }));
    await exchange();

    expect(breadcrumb()).toContain('Mira');
    expect(container.textContent).not.toContain('This page did not load');
    expect(
      server.sent.filter(
        (message) => message.type === 'Authenticate' && message.tokenType === 'None',
      ),
    ).toEqual([]);
  });

  it('takes the new session’s token when the signed-in session changes to another (second pass M4)', async () => {
    const server = syncServer((path, signedIn) => {
      if (path === 'config:surfaceMode') return { value: { mode: 'mock' } };
      if (path !== 'agents:get') return undefined;
      return signedIn ? { value: EMPLOYEE_ROW } : { error: 'not authenticated' };
    });
    vi.stubGlobal('WebSocket', server.Socket);
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://session-switch-test.convex.cloud');
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', undefined);
    const { Providers } = await import('../../../../app/Providers');
    const { default: Layout } = await import('../../../../app/agent/[agentId]/layout');
    const page = await Layout({
      children: <p>tab</p>,
      params: Promise.resolve({ agentId: EMPLOYEE_ROW._id }),
    });
    const signedIn = (sessionId: string) => ({
      isLoaded: true,
      isSignedIn: true,
      sessionId,
      getToken: clerk.getToken,
    });
    act((): void => clerk.answer(signedIn('sess_a')));
    const { container } = mount(
      <Providers>
        <Boundary>{page}</Boundary>
      </Providers>,
    );
    await exchange();
    const authenticated = (): number =>
      server.sent.filter(
        (message) => message.type === 'Authenticate' && message.tokenType === 'User',
      ).length;
    const before = authenticated();
    expect(before).toBeGreaterThan(0);

    // Clerk moves the page to another session, answering "not loaded" between the two.
    act((): void => clerk.answer({ isLoaded: false, getToken: clerk.getToken }));
    act((): void => clerk.answer(signedIn('sess_b')));
    await exchange();

    expect(authenticated()).toBeGreaterThan(before);
    expect(container.querySelector('nav[aria-label="Breadcrumb"]')?.textContent).toContain('Mira');
    expect(container.textContent).not.toContain('This page did not load');
  });
});
