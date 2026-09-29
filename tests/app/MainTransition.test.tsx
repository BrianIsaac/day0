/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: (): string => route.pathname }));

import { MainTransition, pageKey } from '../../app/MainTransition';

let host: HTMLDivElement;

beforeEach((): void => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
});

afterEach((): void => {
  host.remove();
  route.pathname = '/';
});

describe('MainTransition', (): void => {
  it('holds the page in the one main the skip link targets', (): void => {
    const root = createRoot(host);
    act((): void => root.render(<MainTransition>page</MainTransition>));
    const mains = host.querySelectorAll('main');
    expect(mains).toHaveLength(1);
    expect(mains[0]?.id).toBe('main');
    expect(mains[0]?.getAttribute('tabindex')).toBe('-1');
    expect(mains[0]?.textContent).toBe('page');
    act((): void => root.unmount());
  });

  it('gives each page its own main, so the old one exits where it was read and the new one enters', (): void => {
    const root = createRoot(host);
    act((): void => root.render(<MainTransition>landing</MainTransition>));
    const before = host.querySelector('main');
    route.pathname = '/walkthrough';
    act((): void => root.render(<MainTransition>walkthrough</MainTransition>));
    const after = host.querySelector('main');
    expect(host.querySelectorAll('main')).toHaveLength(1);
    expect(after).not.toBe(before);
    expect(after?.textContent).toBe('walkthrough');
    act((): void => root.unmount());
  });

  it('keeps the main when the page changes under one address', (): void => {
    const root = createRoot(host);
    act((): void => root.render(<MainTransition>first</MainTransition>));
    const before = host.querySelector('main');
    act((): void => root.render(<MainTransition>second</MainTransition>));
    expect(host.querySelector('main')).toBe(before);
    act((): void => root.unmount());
  });

  it('keeps the main through the steps of Clerk’s sign-in, which walks its own sub-paths', (): void => {
    const root = createRoot(host);
    route.pathname = '/sign-in';
    act((): void => root.render(<MainTransition>sign in</MainTransition>));
    const before = host.querySelector('main');
    route.pathname = '/sign-in/factor-one';
    act((): void => root.render(<MainTransition>factor one</MainTransition>));
    expect(host.querySelector('main')).toBe(before);
    act((): void => root.unmount());
  });
});

describe('pageKey', (): void => {
  it('is the pathname, with a sign-in or sign-up step folded into its page', (): void => {
    expect(pageKey('/walkthrough')).toBe('/walkthrough');
    expect(pageKey('/agent/a1')).toBe('/agent/a1');
    expect(pageKey('/sign-in')).toBe('/sign-in');
    expect(pageKey('/sign-in/sso-callback')).toBe('/sign-in');
    expect(pageKey('/sign-up/verify-email-address')).toBe('/sign-up');
    expect(pageKey(null)).toBe('');
  });

  it("folds an employee's tabs into its page, so a tab change keeps the page and plays nothing", (): void => {
    expect(pageKey('/agent/a1/work')).toBe('/agent/a1');
    expect(pageKey('/agent/a1/charter')).toBe('/agent/a1');
    expect(pageKey('/agent/a2/work')).toBe('/agent/a2');
  });
});
