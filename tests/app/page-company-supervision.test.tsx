import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { getFunctionName, type FunctionReference } from 'convex/server';

/**
 * The signed-in landing page with one employee whose company figures exist:
 * the company supervision card sits below the roster and the office, above
 * the reset card (v4 section 1.3's order for the main column).
 */
vi.mock('@clerk/nextjs', () => ({
  Show: (): null => null,
  useUser: () => ({
    user: { primaryEmailAddress: { emailAddress: 'boss@example.invalid' }, firstName: 'Boss' },
  }),
}));

const EMPLOYEE_METRICS = {
  charter: {
    timeToFirstDraftedMs: 1,
    timeToFirstApprovedMs: 67_000,
    requestChanges: 0,
  },
  decisions: {
    requested: 0,
    approved: 0,
    rejected: 0,
    partiallyApproved: 0,
    cancelled: 0,
    medianLatencyMs: null,
    p90LatencyMs: null,
    byVia: {
      dashboard: { decided: 0, medianLatencyMs: null, p90LatencyMs: null },
      channel: { decided: 0, medianLatencyMs: null, p90LatencyMs: null },
    },
  },
  actions: {
    autoApplied: 0,
    automatic: { reads: 0, managerMessages: 0, writes: 0 },
    sessionRestores: 0,
    held: 0,
    approved: 0,
    rejected: 0,
    refused: 0,
    blockedAfterRevocation: null,
    firstBlockAfterRevocationMs: null,
  },
  surfaces: { approved: 0, rejected: 0, absent: 0 },
  skills: { approved: 0, rejected: 0 },
  autonomyChanges: 0,
  auditTrail: { complete: 0, total: 0, fraction: null },
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
    const name = getFunctionName(reference);
    if (name === 'agents:listForUser') {
      return [
        { _id: 'synthetic-owner-agent', name: 'Recorded colleague', state: 'active', createdAt: 1 },
      ];
    }
    if (name === 'metrics:forOwner') {
      return {
        employees: [
          {
            agentId: 'synthetic-owner-agent',
            name: 'Recorded colleague',
            deployedAt: 1,
            metrics: EMPLOYEE_METRICS,
          },
        ],
        company: {
          employees: 1,
          charter: {
            timesToFirstApprovedMs: [67_000],
            medianTimeToFirstApprovedMs: 67_000,
            approvedEmployees: 1,
          },
          decisions: EMPLOYEE_METRICS.decisions,
          actions: EMPLOYEE_METRICS.actions,
          surfaces: EMPLOYEE_METRICS.surfaces,
          skills: EMPLOYEE_METRICS.skills,
          autonomyChanges: 0,
          auditTrail: EMPLOYEE_METRICS.auditTrail,
          pilot: EMPLOYEE_METRICS.pilot,
        },
        excludedAgents: 0,
        omittedEmployees: 0,
      };
    }
    if (name === 'docSources:listMine') return [];
    // Every other query is still loading, so the test does not depend on
    // what the rest of the page reads.
    return undefined;
  },
  useMutation: (): (() => Promise<void>) => async (): Promise<void> => undefined,
}));

vi.mock('next/navigation', () => ({
  useRouter: (): { push: () => void } => ({ push: (): void => undefined }),
}));

import LandingPage from '../../app/page';

describe('the landing page with a company', (): void => {
  it('shows the company supervision card below the roster and the office, where the drawn home puts the figures', (): void => {
    const html = renderToStaticMarkup(<LandingPage />);
    const card = html.indexOf('Company supervision');

    expect(card).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(html.indexOf('Your employees'));
    expect(card).toBeGreaterThan(html.indexOf('Mini office world'));
    expect(card).toBeLessThan(html.indexOf('Reset demo'));
    expect(html).toContain('1 min 7 s');
  });
});
