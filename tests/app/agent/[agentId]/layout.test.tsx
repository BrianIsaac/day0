/** @vitest-environment jsdom */

import { Component, isValidElement, type ReactNode } from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EmployeeLayout from '../../../../app/agent/[agentId]/layout';
import { EmployeeShell } from '../../../../app/agent/[agentId]/EmployeeShell';
import { SessionGate } from '../../../../app/Providers';
import { mount, unmountAll } from '../../../fixtures/dom/press';
import { EMPLOYEE_ROW } from '../../../fixtures/dom/employee';
import {
  syncServer,
  type ClientMessage,
  type SyncServer,
} from '../../../fixtures/convex/sync-socket';

/** Clerk as the page sees it: loading until the test says it has answered. */
const clerk = vi.hoisted(() => {
  interface ClerkAuth {
    readonly isLoaded: boolean;
    readonly isSignedIn?: boolean;
    readonly sessionId?: string;
    readonly getToken: () => Promise<string>;
  }
  const listeners = new Set<() => void>();
  let auth: ClerkAuth;
  // Clerk's `getToken` is one function from the first render, before its script has answered; it
  // mints for whichever session Clerk holds when asked, `sess_b` being a second user.
  const getToken = async (): Promise<string> => {
    const part = (value: object): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const sub = auth.sessionId === 'sess_b' ? 'user_2' : 'user_1';
    return `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ sub, iat: now, exp: now + 3600 })}.c2ln`;
  };
  auth = { isLoaded: false, getToken };
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
  usePathname: (): string => '/agent/j57agent',
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

/** The most turns an exchange may take before the test calls it stuck. */
const EXCHANGE_TURNS = 200;

/**
 * Let the socket open and every message between the client and the deployment land: turn the
 * event loop until nothing is on the wire and a whole turn has passed with nothing new sent.
 */
async function exchange(server: SyncServer): Promise<void> {
  let seen = -1;
  for (let turn = 0; turn < EXCHANGE_TURNS; turn += 1) {
    await act(async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (server.quiet() && server.sent.length === seen) return;
    seen = server.sent.length;
  }
  throw new Error(`the exchange with the deployment was still going after ${EXCHANGE_TURNS} turns`);
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
    await exchange(server);
    expect(container.textContent).not.toContain('This page did not load');
    expect(server.sent.flatMap(addsOf)).not.toContain('agents:get');

    act((): void => clerk.answer({ isLoaded: true, isSignedIn: true, getToken: clerk.getToken }));
    await exchange(server);

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
    await exchange(server);
    const breadcrumb = (): string | undefined =>
      container.querySelector('nav[aria-label="Breadcrumb"]')?.textContent ?? undefined;
    expect(breadcrumb()).toContain('Mira');

    // Clerk refreshing an expiring session answers "not loaded" again for a moment.
    act((): void => clerk.answer({ isLoaded: false, getToken: clerk.getToken }));
    await exchange(server);

    expect(breadcrumb()).toContain('Mira');
    expect(container.textContent).not.toContain('This page did not load');
    expect(
      server.sent.filter(
        (message) => message.type === 'Authenticate' && message.tokenType === 'None',
      ),
    ).toEqual([]);
  });

  it('draws the second user’s answer, never the first user’s employee, when the signed-in session changes to another (second pass M4, second review x3)', async () => {
    // The deployment answers each user for their own rows: the employee is the first user's.
    const server = syncServer((path, signedIn, subject) => {
      if (path === 'config:surfaceMode') return { value: { mode: 'mock' } };
      if (path !== 'agents:get') return undefined;
      if (!signedIn) return { error: 'not authenticated' };
      return { value: subject === 'user_1' ? EMPLOYEE_ROW : null };
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
    await exchange(server);
    expect(container.querySelector('nav[aria-label="Breadcrumb"]')?.textContent).toContain('Mira');

    // Clerk moves the page to the second user's session, answering "not loaded" between the two.
    act((): void => clerk.answer({ isLoaded: false, getToken: clerk.getToken }));
    act((): void => clerk.answer(signedIn('sess_b')));
    await exchange(server);

    const subjects = server.sent
      .filter((message) => message.type === 'Authenticate' && message.tokenType === 'User')
      .map((message) => {
        const payload = String(message.value).split('.')[1] ?? '';
        return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub: string })
          .sub;
      });
    expect(subjects.at(0)).toBe('user_1');
    expect(subjects.at(-1)).toBe('user_2');
    // The page is the second user's answer: no such employee, and nothing of the first user's.
    expect(container.querySelector('h1')?.textContent).toBe('No such employee');
    expect(container.querySelector('nav[aria-label="Breadcrumb"]')).toBeNull();
    expect(container.textContent).not.toContain('Mira');
    expect(container.textContent).not.toContain(EMPLOYEE_ROW.bossEmail);
    expect(container.textContent).not.toContain('This page did not load');
  });

  it('takes the drawn page away when the manager signs out in another tab (second review x1)', async () => {
    const server = syncServer((path, signedIn) => {
      if (path === 'config:surfaceMode') return { value: { mode: 'mock' } };
      if (path !== 'agents:get') return undefined;
      return signedIn ? { value: EMPLOYEE_ROW } : { error: 'not authenticated' };
    });
    vi.stubGlobal('WebSocket', server.Socket);
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://sign-out-test.convex.cloud');
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', undefined);
    const { Providers } = await import('../../../../app/Providers');
    const { default: Layout } = await import('../../../../app/agent/[agentId]/layout');
    const page = await Layout({
      children: <p>tab</p>,
      params: Promise.resolve({ agentId: EMPLOYEE_ROW._id }),
    });
    act((): void =>
      clerk.answer({
        isLoaded: true,
        isSignedIn: true,
        sessionId: 'sess_a',
        getToken: clerk.getToken,
      }),
    );
    const { container } = mount(
      <Providers>
        <Boundary>{page}</Boundary>
      </Providers>,
    );
    await exchange(server);
    expect(container.querySelector('nav[aria-label="Breadcrumb"]')?.textContent).toContain('Mira');

    // The other tab signed out: Clerk here settles with no session, and Convex with nobody.
    act((): void => clerk.answer({ isLoaded: true, isSignedIn: false, getToken: clerk.getToken }));
    await exchange(server);

    expect(container.querySelector('nav[aria-label="Breadcrumb"]')).toBeNull();
    expect(container.textContent).not.toContain('Mira');
    expect(container.textContent).not.toContain(EMPLOYEE_ROW.bossEmail);
    expect(container.textContent).not.toContain('This page did not load');
    expect(container.querySelector('h1')?.textContent).toBe('You are signed out');
    expect(container.querySelector('a[href^="/sign-in"]')?.getAttribute('href')).toBe(
      '/sign-in?redirect_url=%2Fagent%2Fj57agent',
    );
  });
});
