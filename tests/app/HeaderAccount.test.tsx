import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** What Clerk answers: `user` is undefined until its script has loaded, null when signed out. */
const clerk = vi.hoisted(
  (): {
    user: { primaryEmailAddress: { emailAddress: string }; firstName: string } | null | undefined;
    appearance: Record<string, unknown>;
  } => ({ user: undefined, appearance: {} }),
);

vi.mock('@clerk/nextjs', () => ({
  useUser: () =>
    clerk.user === undefined
      ? { isLoaded: false, isSignedIn: undefined, user: undefined }
      : { isLoaded: true, isSignedIn: clerk.user !== null, user: clerk.user },
  useClerk: () => ({ status: clerk.user === undefined ? 'loading' : 'ready' }),
  Show: ({ when, children }: { when: string; children: ReactNode }): ReactNode =>
    clerk.user !== undefined && (when === 'signed-in') === (clerk.user !== null) ? children : null,
  SignInButton: ({ children, appearance }: { children: ReactNode; appearance?: unknown }) => {
    clerk.appearance.signIn = appearance;
    return children;
  },
  SignUpButton: ({ children, appearance }: { children: ReactNode; appearance?: unknown }) => {
    clerk.appearance.signUp = appearance;
    return children;
  },
  UserButton: ({
    appearance,
    userProfileProps,
  }: {
    appearance?: unknown;
    userProfileProps?: { appearance?: unknown };
  }): ReactNode => {
    clerk.appearance.account = appearance;
    clerk.appearance.profile = userProfileProps?.appearance;
    return <button type="button">Open user menu</button>;
  },
}));

import { HeaderAccount } from '../../app/HeaderAccount';
import { clerkAppearance } from '../../app/clerk-appearance';

const MANAGER = {
  primaryEmailAddress: { emailAddress: 'boss@example.invalid' },
  firstName: 'Boss',
};

afterEach((): void => {
  clerk.user = undefined;
  clerk.appearance = {};
});

/** The header's account slot as the server, or a browser Clerk has answered, draws it. */
function render(): string {
  return renderToStaticMarkup(<HeaderAccount />);
}

/** How each reservation opens: the sign-in controls' copy is inert, the menu's box is empty. */
const RESERVATION_OPENS = {
  'signed-out': /<div aria-hidden="true" inert=""[^>]*>/,
  'signed-in': /<div aria-hidden="true"[^>]*\bsize-11\b[^>]*><\/div>/,
} as const;

/** The element that holds room for one of Clerk's controls, whole, or undefined when there is none. */
function reservation(html: string, answer: 'signed-in' | 'signed-out'): string | undefined {
  const open = RESERVATION_OPENS[answer].exec(html);
  if (!open) return undefined;
  const close = html.indexOf('</div>', open.index);
  return html.slice(open.index, close + '</div>'.length);
}

/** The class list of the element a pattern finds, for comparing two elements' boxes. */
function classOf(html: string, pattern: RegExp): string | undefined {
  return pattern.exec(html)?.[1];
}

describe('the header account controls', (): void => {
  it('gives Sign in and Create account a 44 px target once Clerk has loaded (N14)', (): void => {
    clerk.user = null;
    const html = render();
    const live = html.replace(reservation(html, 'signed-out') ?? '', '');
    const buttons = [...live.matchAll(/<button [^>]*>([^<]*)<\/button>/g)];
    expect(buttons.map(([, label]) => label)).toEqual(['Sign in', 'Create account']);
    for (const [button] of buttons) expect(button).toMatch(/\bmin-h-11\b/);
  });

  it('opens the sign-in and create-account modals in the shared appearance', (): void => {
    clerk.user = null;
    render();
    expect(clerk.appearance.signIn).toBe(clerkAppearance);
    expect(clerk.appearance.signUp).toBe(clerkAppearance);
  });

  it('opens the account menu in the shared appearance once signed in', (): void => {
    clerk.user = MANAGER;
    render();
    expect(clerk.appearance.account).toBe(clerkAppearance);
    // Manage account opens the profile as a modal of its own, which takes the appearance too.
    expect(clerk.appearance.profile).toBe(clerkAppearance);
  });
});

describe("the account slot's room (the header nav shift of 30 September)", (): void => {
  it('holds room for both controls before Clerk answers, for the head script to choose between', (): void => {
    const html = render();
    expect(reservation(html, 'signed-out')).toBeDefined();
    expect(reservation(html, 'signed-in')).toBeDefined();
    expect(html).not.toContain('Open user menu');
  });

  it("holds the sign-in controls' room with the live buttons' own markup, out of reach", (): void => {
    const waiting = reservation(render(), 'signed-out') ?? '';
    expect(waiting).toMatch(/^<div aria-hidden="true" inert="" [^>]*class="[^"]*\binvisible\b/);

    clerk.user = null;
    const answered = render();
    const held = reservation(answered, 'signed-out') ?? '';
    const liveButtons = answered.replace(held, '').match(/<button [^>]*>[^<]*<\/button>/g);
    expect(held.match(/<button [^>]*>[^<]*<\/button>/g)).toEqual(liveButtons);
    expect(waiting.match(/<button [^>]*>[^<]*<\/button>/g)).toEqual(liveButtons);
  });

  it("holds only the sign-in controls' room once Clerk says signed out", (): void => {
    clerk.user = null;
    const html = render();
    expect(reservation(html, 'signed-out')).toBeDefined();
    expect(reservation(html, 'signed-in')).toBeUndefined();
  });

  it("leaves the choice to the head's hint only until Clerk answers, then to Clerk", (): void => {
    const waiting = render();
    expect(reservation(waiting, 'signed-out')).toContain('data-account-reserve="signed-out"');
    expect(reservation(waiting, 'signed-in')).toContain('data-account-reserve="signed-in"');
    // Signed in or out inside the page, the hint on <html> is stale; Clerk's answer is not.
    clerk.user = MANAGER;
    expect(reservation(render(), 'signed-in')).not.toContain('data-account-reserve');
    clerk.user = null;
    expect(reservation(render(), 'signed-out')).not.toContain('data-account-reserve');
  });

  it("holds only the account menu's room once signed in, the same box the avatar mounts in", (): void => {
    clerk.user = MANAGER;
    const html = render();
    expect(reservation(html, 'signed-out')).toBeUndefined();
    const held = classOf(reservation(html, 'signed-in') ?? '', /class="([^"]*)"/);
    const live = classOf(html, /<div class="([^"]*)"><button type="button">Open user menu/);
    expect(held).toMatch(/\bsize-11\b/);
    expect(held).toBe(live);
  });
});

describe('the no-auth badge', (): void => {
  afterEach((): void => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('says no-auth mode is on at the 12 px floor, never below it (m8)', async (): Promise<void> => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
    vi.resetModules();
    const { HeaderAccount: Badged } = await import('../../app/HeaderAccount');
    const html = renderToStaticMarkup(<Badged />);
    expect(html).toContain('No-auth dev mode');
    expect(html).not.toMatch(/text-\[(9|10|11)px\]/);
  });
});
