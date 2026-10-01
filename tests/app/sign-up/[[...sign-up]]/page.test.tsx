import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const clerk = vi.hoisted(() => ({ appearance: [] as unknown[], pathname: '/sign-up' }));

vi.mock('@clerk/nextjs', () => ({
  SignUp: ({ appearance }: { appearance?: unknown }): null => {
    clerk.appearance.push(appearance);
    return null;
  },
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string): never => {
    throw new Error(`redirect ${to}`);
  },
  usePathname: (): string => clerk.pathname,
}));

import SignUpPage from '../../../../app/sign-up/[[...sign-up]]/page';
import { clerkAppearance } from '../../../../app/clerk-appearance';

/**
 * The page's markup on a Clerk step, which Clerk routes by path.
 *
 * @param pathname - The path Clerk's step is on.
 */
function render(pathname = '/sign-up'): string {
  clerk.pathname = pathname;
  return renderToStaticMarkup(<SignUpPage />);
}

describe('the sign-up page', (): void => {
  it('asks for an account under its own heading', (): void => {
    expect(render()).toContain('Create an account');
  });

  it("leaves the h1 to Clerk's title on a later step, keeping the heading's words and look", (): void => {
    const heading = /<h1 class="([^"]+)">Create an account<\/h1>/.exec(render());
    expect(heading).not.toBeNull();
    const later = render('/sign-up/verify-email-address');
    expect(later).not.toMatch(/<h1[\s>]/);
    expect(later).toContain(`<p class="${heading?.[1]}">Create an account</p>`);
  });

  it('leaves the one main landmark to the layout', (): void => {
    expect(render()).not.toMatch(/<main[\s>]/);
  });

  it("dresses Clerk's sign-up in the shared appearance, so its text reads on the dark page", (): void => {
    clerk.appearance.length = 0;
    render();
    expect(clerk.appearance).toEqual([expect.objectContaining(clerkAppearance)]);
  });

  it("leaves the card's title and subtitle out on the first step only, where the page's h1 says it, and keeps the mark (walk m26)", (): void => {
    clerk.appearance.length = 0;
    render();
    render('/sign-up/verify-email-address');
    const [first, later] = clerk.appearance;
    expect(first).toMatchObject({
      options: clerkAppearance.options,
      elements: { headerTitle: { display: 'none' }, headerSubtitle: { display: 'none' } },
    });
    expect(first).not.toHaveProperty('elements.logoBox');
    expect(later).toBe(clerkAppearance);
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
