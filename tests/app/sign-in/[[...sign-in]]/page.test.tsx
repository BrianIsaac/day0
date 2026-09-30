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
async function render(pathname = '/sign-in'): Promise<string> {
  clerk.pathname = pathname;
  const { default: SignInPage } = await import('../../../../app/sign-in/[[...sign-in]]/page');
  return renderToStaticMarkup(<SignInPage />);
}

/** Markup with entities resolved, so copy can be matched as it reads. */
const text = (html: string): string => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

describe('the sign-in page', () => {
  it('asks the manager to sign in to deploy an employee, not an agent (N29)', async () => {
    const html = await render();
    expect(html).toMatch(/<h1[^>]*>Sign in to deploy an employee<\/h1>/);
    expect(html).not.toMatch(/\bagent\b/i);
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

  it('says that nothing reaches a real system once, in the notice, not again in the lede', async () => {
    const html = text(await render());
    expect(html.match(/reaches a real system/g)).toHaveLength(1);
    expect(html).toContain(HOSTED_DEMO_NOTICE.paragraphs[0]);
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
    const { clerkAppearance } = await import('../../../../app/clerk-appearance');
    expect(clerk.appearance).toEqual([expect.objectContaining(clerkAppearance)]);
  });

  it("leaves the card's title and subtitle out on the first step only, where the page's h1 says it, and keeps the mark (walk m26)", async () => {
    clerk.appearance.length = 0;
    await render();
    await render('/sign-in/factor-one');
    const { clerkAppearance } = await import('../../../../app/clerk-appearance');
    const [first, later] = clerk.appearance;
    expect(first).toMatchObject({
      options: clerkAppearance.options,
      elements: { headerTitle: { display: 'none' }, headerSubtitle: { display: 'none' } },
    });
    expect(first).not.toHaveProperty('elements.logoBox');
    expect(later).toBe(clerkAppearance);
  });

  it('sends the local manager home in no-auth dev mode, where there is nothing to sign in to', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
    vi.stubEnv('NODE_ENV', 'development');
    await expect(render()).rejects.toThrow('redirect /');
  });
});
