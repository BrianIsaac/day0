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

import { HeadedSignIn, HeadedSignUp } from '../../app/HeadedClerk';
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
