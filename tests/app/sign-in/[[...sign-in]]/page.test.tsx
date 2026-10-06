import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOSTED_DEMO_NOTICE } from '../../../../src/demo/hosted-notice';

const clerk = vi.hoisted(() => ({ appearance: [] as unknown[], pathname: '/sign-in' }));

vi.mock('@clerk/nextjs', () => ({
  SignIn: ({ appearance }: { appearance?: unknown }) => {
    clerk.appearance.push(appearance);
    return <div data-clerk-sign-in="" />;
  },
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string): never => {
    throw new Error(`redirect ${to}`);
  },
  usePathname: (): string => clerk.pathname,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * The page's markup on a Clerk step, which Clerk routes by path.
 *
 * @param pathname - The path Clerk's step is on.
 */
async function render(
  pathname = '/sign-in',
  search: Record<string, string | string[]> = {},
): Promise<string> {
  clerk.pathname = pathname;
  const { default: SignInPage } = await import('../../../../app/sign-in/[[...sign-in]]/page');
  return renderToStaticMarkup(await SignInPage({ searchParams: Promise.resolve(search) }));
}

/** Markup with entities resolved, so copy can be matched as it reads. */
const text = (html: string): string => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

describe('the sign-in page', () => {
  it('asks the manager to sign in to deploy an employee, not an agent (N29)', async () => {
    const html = await render();
    expect(html).toMatch(/<h1[^>]*>Sign in to deploy an employee<\/h1>/);
    expect(html).not.toMatch(/\bagent\b/i);
  });

  it("says a visitor sent to sign in from a page they asked for continues there, never that they deploy (the round review's m23)", async () => {
    const returning = await render('/sign-in', {
      redirect_url: 'https://dayzer0.dev/agent/k57abc/work?from=review',
    });
    expect(returning).toMatch(/<h1[^>]*>Sign in to continue<\/h1>/);
    // The new manager's first steps are not this visitor's (the second pass's design reader).
    expect(returning).not.toContain('Give your first employee a name.');
    expect(await render('/sign-in')).toContain('Give your first employee a name.');
    for (const landing of ['https://dayzer0.dev/', '/']) {
      expect(await render('/sign-in', { redirect_url: landing })).toMatch(
        /<h1[^>]*>Sign in to deploy an employee<\/h1>/,
      );
    }
    // Re-pinned by 13-FD (the v0.16.0 redeploy's finding 5): `/home` is a returning manager's.
    expect(await render('/sign-in', { redirect_url: 'https://dayzer0.dev/home' })).toMatch(
      /<h1[^>]*>Sign in to continue<\/h1>/,
    );
    expect(await render('/sign-in', { redirect_url: 'not an address' })).toMatch(
      /<h1[^>]*>Sign in to deploy an employee<\/h1>/,
    );
  });

  it("leaves the h1 to Clerk's title on a later step, keeping the heading's words and look", async () => {
    const first = await render('/sign-in');
    const heading = /<h1 class="([^"]+)">Sign in to deploy an employee<\/h1>/.exec(first);
    expect(heading).not.toBeNull();
    const later = await render('/sign-in/factor-one');
    expect(later).not.toMatch(/<h1[\s>]/);
    expect(later).toContain(`<p class="${heading?.[1]}">Sign in to deploy an employee</p>`);
  });

  it('says what the hosted demo collects and who receives it before the sign-in (N6)', async () => {
    const html = text(await render());
    expect(html).toContain('role="note"');
    expect(html).toContain(HOSTED_DEMO_NOTICE.heading);
    for (const paragraph of HOSTED_DEMO_NOTICE.paragraphs) expect(html).toContain(paragraph);
    expect(html).toContain(`href="${HOSTED_DEMO_NOTICE.link.href}"`);
    expect(html.indexOf(HOSTED_DEMO_NOTICE.heading)).toBeLessThan(
      html.indexOf('data-clerk-sign-in'),
    );
  });

  // Re-pinned (wave 9): the notice is drawn twice, folded for a phone and open for a wide
  // screen, one of them shown at a time; the lede still never says it.
  it('says that nothing reaches a real system once in each form of the notice, not again in the lede', async () => {
    const html = text(await render());
    expect(html.match(/reaches a real system/g)).toHaveLength(2);
    expect(html.match(new RegExp(HOSTED_DEMO_NOTICE.paragraphs[0], 'g'))).toHaveLength(2);
    const lede = /<p class="[^"]*">\s*The hosted office is a seeded, synthetic[^<]*<\/p>/.exec(
      html,
    );
    expect(lede?.[0]).not.toMatch(/real system/);
  });

  it('folds the notice under its heading on a phone and keeps it open on a wide screen, both before the card (the v0.11.0 walk)', async () => {
    const html = text(await render());
    const folded = html.indexOf('<details');
    const open = html.indexOf('<div class="hidden md:block">');
    const card = html.indexOf('id="sign-in-card"');
    expect(folded).toBeGreaterThan(-1);
    expect(folded).toBeLessThan(card);
    expect(open).toBeLessThan(card);
    // The folded one names the notice in its summary, so its heading is read before the card.
    expect(html.slice(folded, card)).toMatch(
      new RegExp(`<summary[^>]*>[\\s\\S]*${HOSTED_DEMO_NOTICE.heading}[\\s\\S]*</summary>`),
    );
    for (const paragraph of HOSTED_DEMO_NOTICE.paragraphs)
      expect(html.slice(folded, open)).toContain(paragraph);
    expect(html.slice(folded, open)).toContain(`href="${HOSTED_DEMO_NOTICE.link.href}"`);
  });

  it('shows one form of the notice at each width, and the steps after the card on a phone only', async () => {
    const html = await render();
    expect(html).toMatch(/<div role="note" class="[^"]*\bmd:hidden\b/);
    expect(html).toMatch(/<div class="hidden md:block"><div role="note"/);
    expect(html).toMatch(/<div class="order-last [^"]*md:order-none[^"]*"><p /);
    expect(html).toMatch(/<div class="contents md:flex /);
  });

  it('leaves the one main landmark to the layout', async () => {
    expect(await render()).not.toMatch(/<main[\s>]/);
  });

  it('promises a decision only on the writes the employee holds, and a strike before approval', async () => {
    const html = await render();
    expect(html).toContain(
      'Decide on the writes it holds for you, until you turn autonomous actions on.',
    );
    expect(html).toContain('Strike a rule you disagree with, then approve the charter it drafts.');
    expect(html).not.toMatch(/each write before it lands/);
  });

  it("offers Clerk's sign-in beside the notice", async () => {
    expect(await render()).toContain('data-clerk-sign-in');
  });

  it("dresses Clerk's sign-in in the shared appearance, so its text reads on the dark page", async () => {
    clerk.appearance.length = 0;
    await render();
    const { clerkSignInAppearance } = await import('../../../../app/clerk-appearance');
    const { theme, variables, options } = clerkSignInAppearance;
    expect(clerk.appearance).toEqual([expect.objectContaining({ theme, variables, options })]);
  });

  it("leaves the card's header out on the first step only, where the page's h1 says it, and keeps the mark (walk m26)", async () => {
    clerk.appearance.length = 0;
    await render();
    await render('/sign-in/factor-one');
    const { clerkSignInAppearance } = await import('../../../../app/clerk-appearance');
    const [first, later] = clerk.appearance;
    // Re-pinned (wave 9): the mark is above the card, so the whole header is left out and the
    // mark's own box is only spaced, never hidden.
    expect(first).toMatchObject({
      options: clerkSignInAppearance.options,
      elements: { header: { display: 'none' }, logoBox: { marginBottom: '1.75rem' } },
    });
    expect(later).toBe(clerkSignInAppearance);
  });

  it('sends the local manager home in no-auth dev mode, where there is nothing to sign in to', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
    vi.stubEnv('NODE_ENV', 'development');
    await expect(render()).rejects.toThrow('redirect /');
  });
});
