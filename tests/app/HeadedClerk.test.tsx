/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const clerk = vi.hoisted(() => ({
  serverPath: '/sign-in',
  drawn: [] as { widget: string; appearance: unknown }[],
}));

vi.mock('next/navigation', () => ({ usePathname: (): string => clerk.serverPath }));
vi.mock('@clerk/nextjs', () => ({
  SignIn: ({ appearance }: { appearance?: unknown }): null => {
    clerk.drawn.push({ widget: 'sign-in', appearance });
    return null;
  },
  SignUp: ({ appearance }: { appearance?: unknown }): null => {
    clerk.drawn.push({ widget: 'sign-up', appearance });
    return null;
  },
}));

import { HeadedSignIn, HeadedSignUp, StepHeading } from '../../app/HeadedClerk';
import { clerkAppearance, headedClerkAppearance } from '../../app/clerk-appearance';

/** The appearance Clerk was last handed. */
const lastAppearance = (): unknown => clerk.drawn.at(-1)?.appearance;

/**
 * Stand in for the browser's Navigation API: an event target the widget listens on, which the
 * test tells of an entry change as the browser would after Clerk's own `pushState`.
 */
function installNavigation(): EventTarget {
  const navigation = new EventTarget();
  Reflect.set(window, 'navigation', navigation);
  return navigation;
}

afterEach((): void => {
  clerk.serverPath = '/sign-in';
  Reflect.deleteProperty(window, 'navigation');
  window.history.replaceState(null, '', '/');
  clerk.drawn.length = 0;
});

/**
 * Mount a headed widget in the document at `path`.
 *
 * @param widget - The widget to mount.
 * @param path - The path the window starts on.
 */
async function mount(widget: 'sign-in' | 'sign-up', path: string): Promise<() => void> {
  window.history.replaceState(null, '', path);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(widget === 'sign-in' ? <HeadedSignIn /> : <HeadedSignUp />);
  });
  return () => {
    act(() => root.unmount());
    host.remove();
  };
}

describe('a Clerk widget under a page heading', (): void => {
  it("leaves the first step's title out, on the page's own path with or without its slash (walk m26)", async (): Promise<void> => {
    installNavigation();
    for (const [widget, path] of [
      ['sign-in', '/sign-in'],
      ['sign-in', '/sign-in/'],
      ['sign-up', '/sign-up'],
    ] as const) {
      const unmount = await mount(widget, path);
      expect(lastAppearance()).toEqual(headedClerkAppearance(true));
      unmount();
    }
  });

  it("gives a later step its header back when Clerk moves to it with its own pushState, which Next's path never sees", async (): Promise<void> => {
    const navigation = installNavigation();
    const unmount = await mount('sign-in', '/sign-in');
    expect(lastAppearance()).toEqual(headedClerkAppearance(true));

    await act(async () => {
      window.history.pushState(null, '', '/sign-in/factor-one');
      navigation.dispatchEvent(new Event('currententrychange'));
    });
    expect(lastAppearance()).toBe(clerkAppearance);

    // Back to the first step, as the browser's back button takes it and tells the Navigation API.
    await act(async () => {
      window.history.replaceState(null, '', '/sign-in');
      navigation.dispatchEvent(new Event('currententrychange'));
    });
    expect(lastAppearance()).toEqual(headedClerkAppearance(true));
    unmount();
  });

  it('keeps the header on the verification step of sign-up', async (): Promise<void> => {
    installNavigation();
    const unmount = await mount('sign-up', '/sign-up/verify-email-address');
    expect(lastAppearance()).toBe(clerkAppearance);
    unmount();
  });

  it('keeps every title where the browser cannot say when Clerk changes step', async (): Promise<void> => {
    const unmount = await mount('sign-in', '/sign-in');
    expect(lastAppearance()).toBe(clerkAppearance);
    unmount();
  });

  it("renders the first step's appearance on the server, from Next's path", (): void => {
    clerk.serverPath = '/sign-up';
    renderToStaticMarkup(<HeadedSignUp />);
    expect(lastAppearance()).toEqual(headedClerkAppearance(true));
  });
});

/**
 * Mount the page's step heading over the sign-in widget at `path`, as the page draws them.
 *
 * @param path - The path the window starts on.
 */
async function mountPage(path: string): Promise<{ host: HTMLElement; unmount: () => void }> {
  window.history.replaceState(null, '', path);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <>
        <StepHeading base="/sign-in" className="page-heading">
          Sign in to deploy an employee
        </StepHeading>
        <HeadedSignIn />
      </>,
    );
  });
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** The page heading's element, found by its words whatever its tag. */
const pageHeading = (host: HTMLElement): Element | undefined =>
  [...host.querySelectorAll('.page-heading')].find(
    (element) => element.textContent === 'Sign in to deploy an employee',
  );

describe("the page's heading over a Clerk widget", (): void => {
  it('is the one h1 on the first step, where the widget leaves its title out', async (): Promise<void> => {
    installNavigation();
    const { host, unmount } = await mountPage('/sign-in');
    expect(pageHeading(host)?.tagName).toBe('H1');
    expect(lastAppearance()).toEqual(headedClerkAppearance(true));
    unmount();
  });

  it("steps down to a paragraph with the same words and look on a later step, where Clerk's title is the h1", async (): Promise<void> => {
    const navigation = installNavigation();
    const { host, unmount } = await mountPage('/sign-in');
    await act(async () => {
      window.history.pushState(null, '', '/sign-in/factor-one');
      navigation.dispatchEvent(new Event('currententrychange'));
    });
    expect(pageHeading(host)?.tagName).toBe('P');
    expect(host.querySelectorAll('h1')).toHaveLength(0);
    expect(lastAppearance()).toBe(clerkAppearance);

    await act(async () => {
      window.history.replaceState(null, '', '/sign-in');
      navigation.dispatchEvent(new Event('currententrychange'));
    });
    expect(pageHeading(host)?.tagName).toBe('H1');
    unmount();
  });

  it("is a paragraph where the browser cannot say when Clerk changes step, since Clerk's title stays", async (): Promise<void> => {
    const { host, unmount } = await mountPage('/sign-in');
    expect(pageHeading(host)?.tagName).toBe('P');
    expect(lastAppearance()).toBe(clerkAppearance);
    unmount();
  });

  it("renders from Next's path on the server: an h1 on the first step, a paragraph on a later one", (): void => {
    clerk.serverPath = '/sign-in';
    expect(
      renderToStaticMarkup(
        <StepHeading base="/sign-in" className="page-heading">
          Sign in
        </StepHeading>,
      ),
    ).toBe('<h1 class="page-heading">Sign in</h1>');
    clerk.serverPath = '/sign-in/factor-one';
    expect(
      renderToStaticMarkup(
        <StepHeading base="/sign-in" className="page-heading">
          Sign in
        </StepHeading>,
      ),
    ).toBe('<p class="page-heading">Sign in</p>');
  });
});
