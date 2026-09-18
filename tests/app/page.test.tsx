import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { getFunctionName, type FunctionReference } from 'convex/server';

/**
 * The landing page is the judge-facing surface: it is what the hosted demo shows
 * before sign-in. Clerk and Convex are replaced so the signed-out hero renders
 * exactly as it would for a stranger, and the copy can be checked as text.
 */
const authState = vi.hoisted(() => ({ loaded: true, signedIn: false, rosterAvailable: true }));

vi.mock('@clerk/nextjs', () => ({
  Show: ({ when, children }: { when: string; children: ReactNode }): ReactNode =>
    authState.loaded && when === 'signed-out' ? children : null,
  useUser: () => ({ user: authState.signedIn ? { primaryEmailAddress: { emailAddress: 'boss@example.invalid' }, firstName: 'Boss' } : undefined }),
}));

/** The signed-in owner's company as `agents.rosterForUser` returns it, newest first. */
const roster = [
  {
    agentId: 'synthetic-owner-agent',
    name: 'Recorded colleague',
    state: 'active',
    autonomous: true,
    roleLine: 'Own routine revenue operations work from Linear tickets for the RevOps team.',
    openCount: 3,
    needsYou: 1,
    docSourceCount: 1,
  },
  {
    agentId: 'synthetic-finance-agent',
    name: 'Finance colleague',
    state: 'active',
    autonomous: false,
    roleLine: 'Close the month for the finance team.',
    openCount: 2,
    needsYou: 2,
    docSourceCount: 1,
  },
  {
    agentId: 'synthetic-new-agent',
    name: 'New colleague',
    state: 'deployed',
    autonomous: false,
    roleLine: 'charter pending',
    openCount: 0,
    needsYou: 0,
    docSourceCount: 0,
  },
];
let shownRoster = roster;

vi.mock('convex/react', () => ({
  useQuery: (reference: FunctionReference<'query'>) => {
    if (!authState.signedIn) return undefined;
    const name = getFunctionName(reference);
    if (name === 'agents:listForUser') {
      return shownRoster.map((row) => ({ _id: row.agentId, name: row.name, state: row.state, createdAt: 1 }));
    }
    if (name === 'agents:rosterForUser') {
      if (!authState.rosterAvailable) throw new Error('Function agents:rosterForUser is unavailable');
      return shownRoster;
    }
    if (name === 'docSources:listMine') return [{ _id: 'synthetic-doc-source', label: 'Handbook' }];
    return 0;
  },
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

  it('offers a stranger the hosted demo first, through sign-in, and setup second', (): void => {
    expect(html).toContain('Try the demo');
    expect(html).toContain('href="/sign-in"');
    expect(html).toContain('Set up Day0');
    expect(html).toContain('href="/setup"');
    // The demo is the signed-in mock office, so its button goes to sign-in and
    // nowhere else; the recording is a separate page with its own button.
    const demo = /<a\b([^>]*)>Try the demo<\/a>/.exec(html)?.[1] ?? '';
    expect(demo).toContain('href="/sign-in"');
    expect(html).not.toContain('Deploy your first agent');
  });

  it('keeps the recorded walkthrough as its own page, with a button below the loop', (): void => {
    const walkthrough = /<a\b([^>]*)>Watch the recorded walkthrough<\/a>/.exec(html)?.[1] ?? '';
    expect(walkthrough).toContain('href="/demo"');
    // Below the hero and the four loop steps, not beside the two hero CTAs.
    expect(html.indexOf('Watch the recorded walkthrough')).toBeGreaterThan(html.indexOf('Skill creation'));
    const hero = html.slice(html.indexOf('Try the demo'), html.indexOf('Set up Day0'));
    expect(hero).not.toContain('href="/demo"');
  });

  it('boxes the two hero CTAs identically, so neither sits a border taller', (): void => {
    const classesOf = (label: string): string[] => {
      const tag = new RegExp(`<a\\b([^>]*)>${label}</a>`).exec(html)?.[1] ?? '';
      return (/class="([^"]*)"/.exec(tag)?.[1] ?? '').split(' ');
    };
    /* Only the utilities that set the border box. A border on one and none on
       the other made them 46 px and 44 px side by side on the same row. */
    const box = (classes: string[]): string[] =>
      classes
        .filter((c) => /^(px-|py-|p-|border$|border-[0-9]|text-(xs|sm|base)$|rounded)/.test(c))
        .sort();

    const primary = classesOf('Try the demo');
    const secondary = classesOf('Set up Day0');
    expect(primary).not.toEqual(['']);
    expect(box(primary)).toEqual(box(secondary));
    expect(primary).toContain('border-transparent');
  });

  it('says what the demo is before the visitor spends a click on it', (): void => {
    expect(html).toContain('Sign in, deploy an agent into the mock office, and hold its Day-1 1:1 yourself.');
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

describe('signed-in landing', () => {
  it('keeps the owner dashboard agent and documentation links', () => {
    authState.signedIn = true;
    try {
      const html = renderToStaticMarkup(<LandingPage />);
      expect(html).toContain('href="/agent/synthetic-owner-agent"');
      expect(html).toContain('href="/documentation"');
    } finally {
      authState.signedIn = false;
    }
  });
});

describe('the employee list', (): void => {
  const signedIn = (): string => {
    authState.signedIn = true;
    try {
      return renderToStaticMarkup(<LandingPage />);
    } finally {
      authState.signedIn = false;
    }
  };

  it('shows every employee above the office: role, queue, what needs the manager, autonomy', (): void => {
    const html = signedIn();
    const list = html.slice(html.indexOf('Your employees'), html.indexOf('Mini office world'));
    expect(html.indexOf('Your employees')).toBeGreaterThan(-1);
    expect(html.indexOf('Your employees')).toBeLessThan(html.indexOf('Mini office world'));
    for (const row of roster) {
      expect(list).toContain(`href="/agent/${row.agentId}"`);
      expect(list).toContain(row.name);
      expect(list).toContain(row.roleLine);
    }
    expect(list).toContain('3 open \u00b7 1 needs you');
    expect(list).toContain('2 open \u00b7 2 need you');
    expect(list).toContain('0 open \u00b7 0 need you');
    expect(list.match(/acts on its own/g)).toHaveLength(1);
    expect(list.match(/asks first/g)).toHaveLength(2);
  });

  it('puts the role line on each office name plate', (): void => {
    const html = signedIn();
    const office = html.slice(html.indexOf('Mini office world'), html.indexOf('Reset demo'));
    for (const row of roster) expect(office).toContain(row.roleLine);
  });

  it('keeps the hosted one-employee landing under a snapshot', (): void => {
    shownRoster = [roster[0]];
    authState.signedIn = true;
    try {
      expect(renderToStaticMarkup(<LandingPage />)).toMatchSnapshot();
    } finally {
      shownRoster = roster;
      authState.signedIn = false;
    }
  });

  it('confines a missing roster function to the signed-in landing', (): void => {
    authState.signedIn = true;
    authState.rosterAvailable = false;
    try {
      expect(() => renderToStaticMarkup(<LandingPage />)).toThrow(
        'Function agents:rosterForUser is unavailable',
      );
    } finally {
      authState.signedIn = false;
      authState.rosterAvailable = true;
    }
    expect(renderToStaticMarkup(<LandingPage />)).toContain('Try the demo');
  });
});
