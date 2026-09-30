import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const clerk = vi.hoisted(() => ({ appearance: [] as unknown[] }));

vi.mock('@clerk/nextjs', () => ({
  SignUp: ({ appearance }: { appearance?: unknown }): null => {
    clerk.appearance.push(appearance);
    return null;
  },
}));

import SignUpPage from '../../../../app/sign-up/[[...sign-up]]/page';
import { clerkAppearance } from '../../../../app/clerk-appearance';

describe('the sign-up page', (): void => {
  it('asks for an account under its own heading', (): void => {
    expect(renderToStaticMarkup(<SignUpPage />)).toContain('Create an account');
  });

  it('leaves the one main landmark to the layout', (): void => {
    expect(renderToStaticMarkup(<SignUpPage />)).not.toMatch(/<main[\s>]/);
  });

  it("dresses Clerk's sign-up in the shared appearance, so its text reads on the dark page", (): void => {
    clerk.appearance.length = 0;
    renderToStaticMarkup(<SignUpPage />);
    expect(clerk.appearance).toEqual([clerkAppearance]);
  });

  it('puts the widget where its first step leaves its own h1 out, so the page has one (walk m26)', (): void => {
    expect(renderToStaticMarkup(<SignUpPage />)).toContain('<div data-headed-clerk=""');
  });

  it('says what the page is in a TSDoc block on its default export, as the sign-in page does (m7)', (): void => {
    // Resolved by path: under Vite, `new URL(path, import.meta.url)` is an asset address.
    const source = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../app/sign-up/[[...sign-up]]/page.tsx',
      ),
      'utf8',
    );
    expect(source).toMatch(/\/\*\*\n \* [^\n]+[\s\S]*?\*\/\nexport default function SignUpPage\(/);
  });
});
