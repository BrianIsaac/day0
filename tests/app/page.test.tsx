import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { getFunctionName, type FunctionReference } from 'convex/server';

/**
 * The landing page is the public surface: it is what the hosted demo shows
 * before sign-in. Clerk and Convex are replaced so the signed-out hero renders
 * exactly as it would for a stranger, and the copy can be checked as text.
 */
const authState = vi.hoisted(() => ({ loaded: true, signedIn: false, rosterAvailable: true }));

vi.mock('@clerk/nextjs', () => ({
  Show: ({ when, children }: { when: string; children: ReactNode }): ReactNode =>
    authState.loaded && when === 'signed-out' ? children : null,
  useUser: () => ({
    user: authState.signedIn
      ? { primaryEmailAddress: { emailAddress: 'boss@example.invalid' }, firstName: 'Boss' }
      : undefined,
  }),
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
    parkedCount: 0,
    stoppedCount: 0,
    needsYou: 1,
    docSourceCount: 1,
    landedThisMonth: { month: '2026-09', days: [], atLeast: false },
  },
  {
    agentId: 'synthetic-finance-agent',
    name: 'Finance colleague',
    state: 'active',
    autonomous: false,
    roleLine: 'Close the month for the finance team.',
    openCount: 2,
    parkedCount: 0,
    stoppedCount: 0,
    needsYou: 2,
    docSourceCount: 1,
    landedThisMonth: { month: '2026-09', days: [], atLeast: false },
  },
  {
    agentId: 'synthetic-new-agent',
    name: 'New colleague',
    state: 'deployed',
    autonomous: false,
    roleLine: 'charter pending',
    openCount: 0,
    parkedCount: 0,
    stoppedCount: 0,
    needsYou: 0,
    docSourceCount: 0,
    landedThisMonth: { month: '2026-09', days: [], atLeast: false },
  },
];
let shownRoster = roster;

const oneEmployeeMetrics = {
  charter: {
    timeToFirstDraftedMs: 30_000,
    timeToFirstApprovedMs: 67_000,
    requestChanges: 0,
  },
  decisions: {
    requested: 2,
    approved: 2,
    rejected: 0,
    partiallyApproved: 0,
    cancelled: 0,
    medianLatencyMs: 48_000,
    p90LatencyMs: 49_000,
    byVia: {
      dashboard: { decided: 2, medianLatencyMs: 48_000, p90LatencyMs: 49_000 },
      channel: { decided: 0, medianLatencyMs: null, p90LatencyMs: null },
    },
  },
  actions: {
    autoApplied: 25,
    // The 17 September recording: 12 reads, 1 manager message, 12 writes.
    automatic: { reads: 12, managerMessages: 1, writes: 12 },
    sessionRestores: 0,
    held: 1,
    approved: 1,
    rejected: 0,
    refused: 0,
    blockedAfterRevocation: null,
    firstBlockAfterRevocationMs: null,
  },
  surfaces: { approved: 3, rejected: 0, absent: 1 },
  skills: { approved: 3, rejected: 0 },
  autonomyChanges: 1,
  auditTrail: { complete: 26, total: 26, fraction: 1 },
  pilot: {
    skillReuse: { runs: 0, reused: 0, rate: null },
    cycleTime: {
      ended: 0,
      medianToEndMs: null,
      completed: 0,
      medianToCompletionMs: null,
      p90ToCompletionMs: null,
    },
    reorientation: { answered: 0, amended: 0, rate: null },
    hoursSaved: { estimatedItems: 0, hours: null },
    retrieval: { tokens: null, recall: null },
  },
};

vi.mock('convex/react', () => ({
  useQuery: (reference: FunctionReference<'query'>) => {
    if (!authState.signedIn) return undefined;
    const name = getFunctionName(reference);
    if (name === 'agents:listForUser') {
      return shownRoster.map((row) => ({
        _id: row.agentId,
        name: row.name,
        state: row.state,
        createdAt: 1,
      }));
    }
    if (name === 'agents:rosterForUser') {
      if (!authState.rosterAvailable)
        throw new Error('Function agents:rosterForUser is unavailable');
      return shownRoster;
    }
    if (name === 'metrics:forOwner' && shownRoster.length === 1) {
      return {
        employees: [
          {
            agentId: shownRoster[0].agentId,
            name: shownRoster[0].name,
            deployedAt: 1,
            metrics: oneEmployeeMetrics,
          },
        ],
        company: {
          employees: 1,
          charter: {
            timesToFirstApprovedMs: [67_000],
            medianTimeToFirstApprovedMs: 67_000,
            approvedEmployees: 1,
          },
          decisions: oneEmployeeMetrics.decisions,
          actions: oneEmployeeMetrics.actions,
          surfaces: oneEmployeeMetrics.surfaces,
          skills: oneEmployeeMetrics.skills,
          autonomyChanges: 1,
          auditTrail: oneEmployeeMetrics.auditTrail,
          pilot: oneEmployeeMetrics.pilot,
        },
        excludedAgents: 0,
        omittedEmployees: 0,
      };
    }
    if (name === 'docSources:listMine') return [{ _id: 'synthetic-doc-source', label: 'Handbook' }];
    if (name === 'work:needsYou') return { entries: [], total: 0, waitingByEmployee: [] };
    if (name === 'config:surfaceMode') return { mode: 'mock', label: 'mock' };
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
    } finally {
      authState.loaded = true;
    }
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
    expect(html.indexOf('Watch the recorded walkthrough')).toBeGreaterThan(
      html.indexOf('Skill creation'),
    );
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
    expect(html).toContain(
      'Sign in, deploy an agent into the mock office, and hold its Day-1 1:1 yourself.',
    );
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
    expect(footer).toContain('Run Day0 with a compatible model provider or your own model server.');
    expect(footer).not.toContain('Cloudflare');
    expect(footer).not.toContain('ElevenLabs');
  });
});

describe('signed-in landing', () => {
  /** The page for the signed-in owner; the home's own pins are in tests/app/home/SignedInDashboard.test.tsx. */
  const signedIn = (): string => {
    authState.signedIn = true;
    try {
      return renderToStaticMarkup(<LandingPage />);
    } finally {
      authState.signedIn = false;
    }
  };

  it('renders the owner’s company home, with the employee and documentation links', () => {
    const html = signedIn();
    expect(html).toContain('Your employees');
    expect(html).toContain('href="/agent/synthetic-owner-agent"');
    expect(html).toContain('href="/documentation"');
    expect(html).not.toContain('Try the demo');
  });

  it('opens on the deploy form when the owner has nobody deployed', (): void => {
    shownRoster = [];
    try {
      const html = signedIn();
      expect(html).toContain('Deploy a new Day0 employee');
      expect(html.match(/<button[^>]*aria-label="Face \d+"/g)).toHaveLength(29);
    } finally {
      shownRoster = roster;
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
