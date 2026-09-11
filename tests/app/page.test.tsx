import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The landing page is the judge-facing surface: it is what the hosted demo shows
 * before sign-in. Clerk and Convex are replaced so the signed-out hero renders
 * exactly as it would for a stranger, and the copy can be checked as text.
 */
vi.mock('@clerk/nextjs', () => ({
  Show: ({ when, children }: { when: string; children: ReactNode }): ReactNode =>
    when === 'signed-out' ? children : null,
  SignInButton: ({ children }: { children: ReactNode }): ReactNode => children,
  useUser: (): { user: undefined } => ({ user: undefined }),
}));

vi.mock('convex/react', () => ({
  useQuery: (): undefined => undefined,
  useMutation: (): (() => Promise<void>) => async (): Promise<void> => undefined,
}));

vi.mock('next/navigation', () => ({
  useRouter: (): { push: () => void } => ({ push: (): void => undefined }),
}));

vi.mock('../../app/CursorToggle', () => ({
  CursorToggle: (): null => null,
}));

import LandingPage from '../../app/page';

describe('signed-out landing page', (): void => {
  const html = renderToStaticMarkup(<LandingPage />);

  it('states the headline in agreement: plural employees, plural verb', (): void => {
    expect(html).toContain('Enterprise digital employees');
    expect(html).toContain('that just work.');
    expect(html).not.toContain('just works');
    expect(html).toContain('One name in. Everything else is learned state.');
  });
});

describe('landing footer', (): void => {
  const html = renderToStaticMarkup(<LandingPage />);

  it('credits only what the hosted demo runs on', (): void => {
    const footer = /<footer[\s\S]*?<\/footer>/.exec(html)?.[0] ?? '';
    expect(footer).toContain(
      'Built on OpenAI GPT-5.6 Terra · ElevenLabs Conversational AI · Convex · Mastra · Exa · Daytona · Vercel · Clerk',
    );
    expect(footer).not.toContain('Cloudflare');
  });
});
