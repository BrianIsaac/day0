import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The landing page is the judge-facing surface: it is what the hosted demo shows
 * before sign-in. Clerk and Convex are replaced so the signed-out hero renders
 * exactly as it would for a stranger, and the copy can be checked as text.
 */
const authState = vi.hoisted(() => ({ loaded: true }));

vi.mock('@clerk/nextjs', () => ({
  Show: ({ when, children }: { when: string; children: ReactNode }): ReactNode =>
    authState.loaded && when === 'signed-out' ? children : null,
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
  it('renders public entry links before the authentication script loads', () => {
    authState.loaded = false;
    try {
      const pending = renderToStaticMarkup(<LandingPage />);
      expect(pending).toContain('Try the demo');
      expect(pending).toContain('Set up Day0');
    } finally { authState.loaded = true; }
  });

  const html = renderToStaticMarkup(<LandingPage />);

  it('states the headline in agreement: plural employees, plural verb', (): void => {
    expect(html).toContain('Enterprise digital employees');
    expect(html).toContain('that just work.');
    expect(html).not.toContain('just works');
    expect(html).toContain('One name in. Everything else is learned state.');
  });

  it('offers a stranger the recorded demo first and setup second', (): void => {
    expect(html).toContain('Try the demo');
    expect(html).toContain('href="/demo"');
    expect(html).toContain('Set up Day0');
    expect(html).toContain('href="/setup"');
    // Both must be links a signed-out visitor can follow, not sign-in prompts.
    expect(html).not.toContain('Deploy your first agent');
  });

  it('says what the demo is before the visitor spends a click on it', (): void => {
    expect(html).toContain('Explore the mock office and its recorded approval flow');
  });

  it('keeps the source repository, smaller than the two routes into the product', (): void => {
    expect(html).toContain('https://github.com/BrianIsaac/day0');
    expect(html).toContain('>Source<');
    expect(html).not.toContain('View source');
  });

  it('describes the charter without naming who writes it', (): void => {
    expect(html).toContain(
      'The conversation becomes a charter for the boss to review and approve.',
    );
  });

  it('names no model anywhere, because the operator picks the provider', (): void => {
    for (const model of ['GPT-5.6', 'GPT-5.5', 'Terra', 'GLM', 'OpenAI', 'Gemini']) {
      expect(html).not.toContain(model);
    }
  });
});

describe('landing footer', (): void => {
  const html = renderToStaticMarkup(<LandingPage />);

  it('describes what Day0 runs on without naming a provider', (): void => {
    const footer = /<footer[\s\S]*?<\/footer>/.exec(html)?.[0] ?? '';
    expect(footer).toContain(
      'Run Day0 with a compatible model provider or your own model server.',
    );
    expect(footer).not.toContain('Cloudflare');
    expect(footer).not.toContain('ElevenLabs');
  });
});
